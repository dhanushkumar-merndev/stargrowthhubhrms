-- [web-hrms] Identity schema owned by the Rust server (replaces Supabase Auth).
--
-- The HRMS SQL resolves every caller through hrms.current_actor(), which reads
-- JWT-style claims from the transaction setting `request.jwt.claims` (exactly
-- how PostgREST/Supabase pass them). The Rust API verifies its own session
-- cookie, then per transaction does:
--     set local role authenticated;
--     select set_config('request.jwt.claims', '{"sub":..,"role":"authenticated",
--                       "session_id":..,"email":..}', true);
-- so all ported RPCs keep their own authorization unchanged.
--
-- Supabase's own `auth` schema is not used (and never written to).

create schema if not exists iam;
revoke all on schema iam from public;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

-- Functions are callable by the API roles (they only read the caller's own claims).
grant usage on schema iam to anon, authenticated, service_role;

create table if not exists iam.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,                 -- internal alias (never an inbox)
  encrypted_password text,                    -- argon2id PHC string, set by the server
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists iam.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references iam.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  not_after timestamptz,                      -- absolute expiry; null = until revoked
  refreshed_at timestamptz
);
create index if not exists sessions_user_idx on iam.sessions (user_id);

alter table iam.users enable row level security;
alter table iam.sessions enable row level security;
revoke all on iam.users, iam.sessions from public, anon, authenticated;

create or replace function iam.jwt() returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function iam.uid() returns uuid
language sql stable set search_path = '' as $$
  select nullif(iam.jwt() ->> 'sub', '')::uuid
$$;

create or replace function iam.role() returns text
language sql stable set search_path = '' as $$
  select nullif(iam.jwt() ->> 'role', '')
$$;

grant execute on function iam.jwt(), iam.uid(), iam.role() to anon, authenticated, service_role;
