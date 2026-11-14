-- [web-hrms] Two-step sign-in with an authenticator app (TOTP, RFC 6238),
-- PLAN §7 item 3. Recommended for HR and Admin; anyone may turn it on.
--
-- * The shared secret is encrypted by the server (AES-256-GCM, key derived
--   from APP_SECRET) before it reaches the database.
-- * Each 30-second code works once (last_step), so a code seen over a
--   shoulder cannot be replayed.
-- * Ten single-use recovery codes are stored as SHA-256 hashes only.
-- * After the password is right, sign-in hands out a short-lived challenge
--   (5 minutes, 5 tries) instead of a session; the session is created only
--   after a valid code.
-- * An Admin can turn it off for someone who lost their phone (password
--   check required, audited, the person is told).
-- Everything here is reachable only through the server (service role).

create table if not exists iam.totp_factors (
  user_id uuid primary key references iam.users(id) on delete cascade,
  secret_enc bytea not null check (octet_length(secret_enc) between 28 and 128),
  enabled_at timestamptz,
  last_step bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists iam.totp_recovery_codes (
  id bigint generated always as identity primary key,
  user_id uuid not null references iam.users(id) on delete cascade,
  code_hash bytea not null check (octet_length(code_hash) = 32),
  used_at timestamptz,
  unique (user_id, code_hash)
);

create table if not exists iam.login_challenges (
  token_hash bytea primary key check (octet_length(token_hash) = 32),
  user_id uuid not null references iam.users(id) on delete cascade,
  result jsonb not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index if not exists login_challenges_user_idx on iam.login_challenges (user_id, expires_at);

alter table iam.totp_factors enable row level security;
alter table iam.totp_recovery_codes enable row level security;
alter table iam.login_challenges enable row level security;
revoke all on iam.totp_factors, iam.totp_recovery_codes, iam.login_challenges from public, anon, authenticated;

-- ---------------------------------------------------------------- factor

create or replace function iam.totp_get(p_user uuid)
returns table (secret_enc bytea, enabled boolean, last_step bigint)
language sql stable security definer set search_path = '' as $$
  select f.secret_enc, f.enabled_at is not null, f.last_step from iam.totp_factors f where f.user_id = p_user;
$$;

-- A new (not yet enabled) secret; refused while one is enabled.
create or replace function iam.totp_begin(p_user uuid, p_secret_enc bytea) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from iam.totp_factors where user_id = p_user and enabled_at is not null) then
    return false;
  end if;
  insert into iam.totp_factors (user_id, secret_enc) values (p_user, p_secret_enc)
  on conflict (user_id) do update set secret_enc = excluded.secret_enc, last_step = 0, created_at = now();
  return true;
end;
$$;

-- Accepts a time step once: true only when it is newer than the last used.
create or replace function iam.totp_use_step(p_user uuid, p_step bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update iam.totp_factors set last_step = p_step where user_id = p_user and last_step < p_step;
  return found;
end;
$$;

create or replace function iam.totp_enable(p_user uuid, p_code_hashes bytea[]) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update iam.totp_factors set enabled_at = now() where user_id = p_user and enabled_at is null;
  if not found then return false; end if;
  perform iam.totp_replace_codes(p_user, p_code_hashes);
  return true;
end;
$$;

create or replace function iam.totp_replace_codes(p_user uuid, p_code_hashes bytea[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(array_length(p_code_hashes, 1), 0) <> 10 then
    raise exception 'HRMS: ten recovery codes expected' using errcode = '22023';
  end if;
  delete from iam.totp_recovery_codes where user_id = p_user;
  insert into iam.totp_recovery_codes (user_id, code_hash) select p_user, h from unnest(p_code_hashes) h;
end;
$$;

create or replace function iam.totp_use_recovery(p_user uuid, p_code_hash bytea) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update iam.totp_recovery_codes set used_at = now()
   where user_id = p_user and code_hash = p_code_hash and used_at is null;
  return found;
end;
$$;

create or replace function iam.totp_disable(p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from iam.totp_recovery_codes where user_id = p_user;
  delete from iam.login_challenges where user_id = p_user;
  delete from iam.totp_factors where user_id = p_user;
  return found;
end;
$$;

-- ------------------------------------------------------------ challenges

create or replace function iam.challenge_create(p_token_hash bytea, p_user uuid, p_result jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from iam.login_challenges where expires_at < now() - interval '1 day';
  -- At most five live challenges per person; the oldest go first.
  delete from iam.login_challenges where token_hash in (
    select token_hash from iam.login_challenges
    where user_id = p_user and consumed_at is null and expires_at > now()
    order by expires_at desc offset 4);
  insert into iam.login_challenges (token_hash, user_id, result, expires_at)
  values (p_token_hash, p_user, p_result, now() + interval '5 minutes');
end;
$$;

-- Counts one try. Returns the person and stored sign-in result while the
-- challenge is live and has tries left; nothing otherwise.
create or replace function iam.challenge_try(p_token_hash bytea)
returns table (user_id uuid, result jsonb, attempts integer)
language sql security definer set search_path = '' as $$
  update iam.login_challenges c set attempts = c.attempts + 1
   where c.token_hash = p_token_hash and c.consumed_at is null and c.expires_at > now() and c.attempts < 5
  returning c.user_id, c.result, c.attempts;
$$;

create or replace function iam.challenge_consume(p_token_hash bytea) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update iam.login_challenges set consumed_at = now() where token_hash = p_token_hash and consumed_at is null;
  return found;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'iam.totp_get(uuid)', 'iam.totp_begin(uuid, bytea)', 'iam.totp_use_step(uuid, bigint)',
    'iam.totp_enable(uuid, bytea[])', 'iam.totp_replace_codes(uuid, bytea[])', 'iam.totp_use_recovery(uuid, bytea)',
    'iam.totp_disable(uuid)', 'iam.challenge_create(bytea, uuid, jsonb)', 'iam.challenge_try(bytea)',
    'iam.challenge_consume(bytea)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- --------------------------------------------------------- audit, notify

-- Server only: records a two-step event for the account and tells its owner.
create or replace function public.internal_two_step_event(p_auth_user_id uuid, p_event text, p_by uuid default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_e hrms.employees;
begin
  if p_event not in ('enabled', 'disabled', 'reset', 'recovery_used', 'codes_replaced') then
    raise exception 'HRMS: unknown two-step event' using errcode = '22023';
  end if;
  select * into v_e from hrms.employees where auth_user_id = p_auth_user_id;
  if not found then return; end if;
  perform hrms.audit(v_e.org_id, coalesce(p_by, v_e.id), 'two_step.' || p_event, 'employee', v_e.id,
                     null, 'security', v_e.id);
  if p_event in ('enabled', 'disabled', 'reset', 'recovery_used') then
    perform hrms.notify(v_e.org_id, v_e.id, 'account.two_step_' || p_event,
      case p_event
        when 'enabled' then 'Two-step sign-in is on'
        when 'disabled' then 'Two-step sign-in was turned off'
        when 'reset' then 'An Admin turned off your two-step sign-in'
        else 'A recovery code was used' end,
      case p_event
        when 'enabled' then 'Signing in now also needs a code from your authenticator app.'
        when 'recovery_used' then 'If this was not you, change your password now and tell your Admin.'
        else 'If you did not expect this, change your password and tell your Admin.' end,
      '/settings/two-step');
  end if;
end;
$$;
revoke all on function public.internal_two_step_event(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.internal_two_step_event(uuid, text, uuid) to service_role;

-- -------------------------------------------------------------- app RPCs

create or replace function public.get_two_step_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_user uuid;
  v_f iam.totp_factors;
begin
  select auth_user_id into v_user from hrms.employees where id = v_actor.employee_id;
  select * into v_f from iam.totp_factors where user_id = v_user and enabled_at is not null;
  return hrms.ok(jsonb_build_object(
    'enabled', found,
    'enabled_at', v_f.enabled_at,
    'recovery_left', (select count(*) from iam.totp_recovery_codes c where c.user_id = v_user and c.used_at is null),
    'recommended', hrms.is_hr_or_admin(v_actor)));
end;
$$;

-- Admin turns off someone's two-step sign-in (lost phone). Password check
-- first (reauth action 'mfa.reset').
alter table hrms.reauthentication_grants drop constraint if exists reauthentication_grants_action_check;
alter table hrms.reauthentication_grants add constraint reauthentication_grants_action_check check (action in (
  'role.elevate', 'archive.cleanup', 'export.bulk_salary', 'export.annual', 'credentials.reset_admin', 'mfa.reset'));

create or replace function public.reset_two_step(p_employee_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_e hrms.employees;
begin
  perform hrms.require_admin(v_actor);
  select * into v_e from hrms.employees where id = p_employee_id and org_id = v_actor.org_id;
  if not found then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if v_e.id = v_actor.employee_id then
    perform hrms.raise_error('VALIDATION_FAILED', 'Turn off your own two-step sign-in from Settings.');
  end if;
  perform hrms.require_reauth(v_actor, 'mfa.reset', v_e.id, true);
  if v_e.auth_user_id is null or not iam.totp_disable(v_e.auth_user_id) then
    return hrms.ok(jsonb_build_object('reset', false));
  end if;
  perform public.internal_two_step_event(v_e.auth_user_id, 'reset', v_actor.employee_id);
  return hrms.ok(jsonb_build_object('reset', true));
end;
$$;

-- Whether a person has it on (Admin's employee screen).
create or replace function public.get_employee_two_step(p_employee_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_e hrms.employees;
begin
  perform hrms.require_admin(v_actor);
  select * into v_e from hrms.employees where id = p_employee_id and org_id = v_actor.org_id;
  if not found then perform hrms.raise_error('ACCESS_DENIED'); end if;
  return hrms.ok(jsonb_build_object('enabled',
    exists (select 1 from iam.totp_factors f where f.user_id = v_e.auth_user_id and f.enabled_at is not null)));
end;
$$;

select hrms.apply_api_grants();
