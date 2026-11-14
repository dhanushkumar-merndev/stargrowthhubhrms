-- [web-hrms] Opaque cookie sessions (replaces Supabase Auth JWT + refresh).
--
-- The browser holds a random 32-byte token in an HttpOnly `__Host-` cookie.
-- Only sha256(token) is stored. Every request resolves the token to a session
-- (absolute + idle expiry); deleting the row signs that device out at once.
-- hrms.resolve_actor still checks iam.sessions on every RPC, so a password
-- reset (credentials_valid_after) or removal also takes effect immediately.

alter table iam.sessions add column if not exists token_hash bytea;
alter table iam.sessions add column if not exists last_seen_at timestamptz not null default now();
alter table iam.sessions add column if not exists user_agent text check (char_length(user_agent) <= 200);
alter table iam.sessions add column if not exists ip_hash text check (char_length(ip_hash) <= 80);
create unique index if not exists sessions_token_hash_key on iam.sessions (token_hash) where token_hash is not null;

-- Idle timeout: a session unused for this long is dead even before not_after.
create or replace function iam.idle_timeout() returns interval
language sql immutable set search_path = '' as $$ select interval '14 days' $$;

-- Server-only: password hash for an alias (null when unknown).
create or replace function iam.password_for_alias(p_email text)
returns table (user_id uuid, encrypted_password text)
language sql stable security definer set search_path = '' as $$
  select u.id, u.encrypted_password from iam.users u where u.email = lower(btrim(p_email))
$$;

create or replace function iam.create_user(p_email text, p_password_hash text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_password_hash is null or p_password_hash !~ '^\$argon2id\$' then
    raise exception 'iam: password hash must be argon2id' using errcode = '22023';
  end if;
  insert into iam.users (email, encrypted_password) values (lower(btrim(p_email)), p_password_hash)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function iam.set_password(p_user_id uuid, p_password_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_password_hash is null or p_password_hash !~ '^\$argon2id\$' then
    raise exception 'iam: password hash must be argon2id' using errcode = '22023';
  end if;
  update iam.users set encrypted_password = p_password_hash, updated_at = now() where id = p_user_id;
  return found;
end;
$$;

create or replace function iam.create_session(
  p_user_id uuid, p_token_hash bytea, p_user_agent text, p_ip_hash text, p_lifetime interval default interval '30 days'
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if octet_length(p_token_hash) <> 32 then
    raise exception 'iam: token hash must be 32 bytes' using errcode = '22023';
  end if;
  insert into iam.sessions (user_id, token_hash, not_after, user_agent, ip_hash)
  values (p_user_id, p_token_hash, now() + least(p_lifetime, interval '90 days'),
          left(p_user_agent, 200), left(p_ip_hash, 80))
  returning id into v_id;
  return v_id;
end;
$$;

-- Resolves a cookie to (session, user, alias). Expired/idle sessions are
-- deleted and resolve to nothing. last_seen_at is written at most every 5 min.
create or replace function iam.resolve_session(p_token_hash bytea)
returns table (session_id uuid, user_id uuid, email text)
language plpgsql security definer set search_path = '' as $$
declare s iam.sessions;
begin
  select * into s from iam.sessions where token_hash = p_token_hash;
  if not found then return; end if;
  if (s.not_after is not null and s.not_after <= now()) or s.last_seen_at <= now() - iam.idle_timeout() then
    delete from iam.sessions where id = s.id;
    return;
  end if;
  if s.last_seen_at < now() - interval '5 minutes' then
    update iam.sessions set last_seen_at = now(), refreshed_at = now() where id = s.id;
  end if;
  return query select s.id, s.user_id, u.email from iam.users u where u.id = s.user_id;
end;
$$;

create or replace function iam.delete_session(p_session_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from iam.sessions where id = p_session_id;
  return found;
end;
$$;

-- Signs a user out everywhere (optionally keeping one session).
create or replace function iam.delete_user_sessions(p_user_id uuid, p_keep uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  delete from iam.sessions where user_id = p_user_id and id is distinct from p_keep;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

create or replace function iam.purge_expired_sessions() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  delete from iam.sessions
   where (not_after is not null and not_after <= now()) or last_seen_at <= now() - iam.idle_timeout();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'iam.password_for_alias(text)', 'iam.create_user(text, text)', 'iam.set_password(uuid, text)',
    'iam.create_session(uuid, bytea, text, text, interval)', 'iam.resolve_session(bytea)',
    'iam.delete_session(uuid)', 'iam.delete_user_sessions(uuid, uuid)', 'iam.purge_expired_sessions()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ------------------------------------------------- self-service: my devices
-- Signed-in users can see and end their own sessions (never anyone else's).
create or replace function public.list_my_sessions() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor('restricted');
begin
  return hrms.ok(coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'created_at', s.created_at, 'last_seen_at', s.last_seen_at,
      'user_agent', s.user_agent, 'current', s.id = v_actor.session_id) order by s.last_seen_at desc)
    from iam.sessions s where s.user_id = v_actor.auth_user_id), '[]'::jsonb));
end;
$$;

create or replace function public.end_my_session(p_session_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor('restricted');
begin
  delete from iam.sessions where id = p_session_id and user_id = v_actor.auth_user_id;
  if not found then perform hrms.raise_error('NOT_FOUND'); end if;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'auth.session_ended', 'session', p_session_id,
                     jsonb_build_object('current', p_session_id = v_actor.session_id), 'security', v_actor.employee_id);
  return hrms.ok(jsonb_build_object('ended', true));
end;
$$;

create or replace function public.end_my_other_sessions() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor('restricted');
  v_n integer;
begin
  delete from iam.sessions where user_id = v_actor.auth_user_id and id <> v_actor.session_id;
  get diagnostics v_n = row_count;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'auth.sessions_ended', 'employee', v_actor.employee_id,
                     jsonb_build_object('count', v_n), 'security', v_actor.employee_id);
  return hrms.ok(jsonb_build_object('ended', v_n));
end;
$$;

revoke all on function public.list_my_sessions(), public.end_my_session(uuid), public.end_my_other_sessions()
  from public, anon;
grant execute on function public.list_my_sessions(), public.end_my_session(uuid), public.end_my_other_sessions()
  to authenticated;

-- Removing someone from the organisation signs them out of every device.
create or replace function hrms.employee_signout_on_inactive() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'active' and old.status = 'active' and new.auth_user_id is not null then
    delete from iam.sessions where user_id = new.auth_user_id;
  end if;
  return null;
end;
$$;
drop trigger if exists employees_signout_on_inactive on hrms.employees;
create trigger employees_signout_on_inactive after update of status on hrms.employees
  for each row execute function hrms.employee_signout_on_inactive();
