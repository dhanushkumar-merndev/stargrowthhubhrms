-- [web-hrms] Platform changes for the Rust server + PWA.
--
-- 1. pg_cron jobs that woke the Supabase `maintenance` Edge Function through
--    pg_net/Vault are removed. The Rust server runs the same work in-process
--    (server/src/jobs.rs) by calling the same internal_* RPCs. The pure-SQL
--    device day-close job stays in pg_cron.
-- 2. Web Push: push_tokens accepts platform 'web'. The token is the browser's
--    PushSubscription as JSON: {"endpoint":"https://…","keys":{"p256dh":…,"auth":…}}.

do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(jobid) from cron.job
     where jobname in ('hrms-outbox', 'hrms-tick', 'hrms-daily', 'hrms-holidays', 'hrms-sheets');
  end if;
end $$;

alter table hrms.push_tokens drop constraint if exists push_tokens_platform_check;
alter table hrms.push_tokens add constraint push_tokens_platform_check
  check (platform in ('android', 'ios', 'web'));

-- Shape check for a Web Push subscription (endpoint must be https; keys are
-- base64url). Returns null when valid, else a short reason.
create or replace function hrms.web_push_subscription_error(p_token text) returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v jsonb;
begin
  begin
    v := p_token::jsonb;
  exception when others then
    return 'not json';
  end;
  if jsonb_typeof(v) <> 'object' then return 'not an object'; end if;
  if char_length(coalesce(v ->> 'endpoint', '')) > 2048
     or coalesce(v ->> 'endpoint', '') !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[^[:space:]]+$' then
    return 'endpoint must be an https URL';
  end if;
  if coalesce(v -> 'keys' ->> 'p256dh', '') !~ '^[A-Za-z0-9_-]{80,100}=*$' then return 'bad p256dh key'; end if;
  if coalesce(v -> 'keys' ->> 'auth', '') !~ '^[A-Za-z0-9_-]{16,30}=*$' then return 'bad auth key'; end if;
  return null;
end;
$$;

create or replace function public.register_push_token(p_installation_id uuid, p_token text, p_platform text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_token text := p_token;
begin
  if p_installation_id is null or p_platform is null or p_platform not in ('android', 'ios', 'web')
     or char_length(coalesce(p_token, '')) < 20 or char_length(p_token) > 4096 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Invalid token.');
  end if;
  if p_platform = 'web' then
    if hrms.web_push_subscription_error(p_token) is not null then
      perform hrms.raise_error('VALIDATION_FAILED', 'Invalid push subscription.');
    end if;
    -- Canonical form so the same subscription always compares equal.
    v_token := jsonb_build_object('endpoint', p_token::jsonb ->> 'endpoint',
      'keys', jsonb_build_object('p256dh', p_token::jsonb -> 'keys' ->> 'p256dh',
                                 'auth', p_token::jsonb -> 'keys' ->> 'auth'))::text;
  end if;
  update hrms.push_tokens set revoked_at = now()
  where revoked_at is null and (installation_id = p_installation_id or token = v_token);
  insert into hrms.push_tokens (org_id, employee_id, installation_id, token, platform)
  values (v_actor.org_id, v_actor.employee_id, p_installation_id, v_token, p_platform);
  return hrms.ok(jsonb_build_object('registered', true));
end;
$$;

-- The push worker reports dead subscriptions (HTTP 404/410) by token.
create or replace function public.internal_revoke_push_tokens(p_tokens text[]) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_n integer;
begin
  update hrms.push_tokens set revoked_at = now()
   where revoked_at is null and token = any(coalesce(p_tokens, '{}'));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.internal_revoke_push_tokens(text[]) from public, anon, authenticated;
grant execute on function public.internal_revoke_push_tokens(text[]) to service_role;
