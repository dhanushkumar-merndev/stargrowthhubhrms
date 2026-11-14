-- [web-hrms] Adapted from ~/Documents/Projects/november/fingertipssl/supabase/tests/_prelude.sql
-- [web-hrms]   Hand-maintained (tools/port_sql.py no longer overwrites device tests).
-- [web-hrms]   Fixtures now use the real HRMS schema: offices need timezone/location,
-- [web-hrms]   roles come from hrms.role_grants (Manager is a label), and callers need
-- [web-hrms]   an iam.users + iam.sessions row whose email matches employees.auth_alias,
-- [web-hrms]   because hrms.current_actor() validates the session like production does.

-- Shared prelude for every *_test.sql file. `pnpm db:test` pipes this file and
-- then one test file into psql, so each test file runs in its own transaction
-- that is rolled back: the fake fixtures below, and anything the tests do,
-- never persist and never touch real data.
\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = notice;
begin;

create function pg_temp.assert(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'ASSERTION FAILED: %', p_msg; end if;
  raise notice 'ok - %', p_msg;
end $$;

-- Runs p_sql and returns the error message ('' when it succeeded).
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return '';
exception when others then
  return sqlerrm;
end $$;

-- Session id = auth id and alias = u-<auth id>@test.invalid for every fixture login.
create function pg_temp.as_user(p_auth uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_auth, 'role', 'authenticated',
    'session_id', p_auth, 'email', 'u-' || p_auth || '@test.invalid')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
end $$;

-- Device-local wall time p_seconds ago, as the machine would send it.
create function pg_temp.lt(p_seconds integer) returns text language sql as $$
  select to_char((now() at time zone 'Asia/Kolkata') - make_interval(secs => p_seconds), 'YYYY-MM-DD HH24:MI:SS');
$$;

do $$
declare v_schema text := pg_my_temp_schema()::regnamespace::text;
begin
  set local client_min_messages = error;
  execute format('grant usage on schema %I to authenticated, service_role', v_schema);
  execute format('grant execute on all functions in schema %I to authenticated, service_role', v_schema);
end $$;
set local client_min_messages = notice; -- the block above lowered it for the whole transaction

-- Fixtures go in without triggers (no automatic machine PIN for them).
set local session_replication_role = replica;
-- Fake fixtures, inserted only inside this rolled-back transaction (the real
-- database has no demo data). Fixed ids never collide with real rows.
insert into hrms.organizations (id, code, name, timezone) values
  ('00000000-0000-4000-8000-000000000001', 'DEMO', 'Demo Organisation (fake)', 'Asia/Kolkata')
on conflict (id) do nothing;

insert into hrms.offices (id, org_id, name, timezone, location) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Demo HQ', 'Asia/Kolkata',
   extensions.st_setsrid(extensions.st_makepoint(77.5946, 12.9716), 4326)::extensions.geography)
on conflict (id) do nothing;

insert into hrms.employees (id, org_id, employee_code, full_name, status, position_label, join_date,
                            provisioning_state, must_change_password, credentials_valid_after, auth_alias) values
  ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001', 'DEMO-001', 'Asha Rao (fake)',    'active',   'member',  '2025-01-01', 'complete', false, now() - interval '1 day', 'u-10000000-0000-4000-8000-000000000001@test.invalid'),
  ('00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-000000000001', 'DEMO-002', 'Vikram Shah (fake)', 'active',   'member',  '2025-01-01', 'complete', false, now() - interval '1 day', 'u-10000000-0000-4000-8000-000000000002@test.invalid'),
  ('00000000-0000-4000-8000-0000000000e3', '00000000-0000-4000-8000-000000000001', 'DEMO-003', 'Meera Iyer (fake)',  'active',   'manager', '2025-01-01', 'complete', false, now() - interval '1 day', null),
  ('00000000-0000-4000-8000-0000000000e4', '00000000-0000-4000-8000-000000000001', 'DEMO-004', 'Rahul Nair (fake)',  'active',   'member',  '2025-01-01', 'complete', false, now() - interval '1 day', 'u-10000000-0000-4000-8000-000000000004@test.invalid'),
  ('00000000-0000-4000-8000-0000000000e5', '00000000-0000-4000-8000-000000000001', 'DEMO-005', 'Priya Menon (fake)', 'active',   'member',  '2025-01-01', 'complete', false, now() - interval '1 day', null),
  ('00000000-0000-4000-8000-0000000000e6', '00000000-0000-4000-8000-000000000001', 'DEMO-006', 'Karan Gupta (fake)', 'inactive', 'member',  '2025-01-01', 'complete', false, now() - interval '1 day', null)
on conflict (id) do nothing;

-- Roles: Admin (e1) and HR (e2). Manager (e3) is only a label and grants nothing.
insert into hrms.role_grants (org_id, employee_id, role, effective_from) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e1', 'admin', now() - interval '1 day'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000e2', 'hr',    now() - interval '1 day');

-- Login identities + live sessions for the three fixture logins (admin, hr, member).
insert into iam.users (id, email)
select u, 'u-' || u || '@test.invalid' from unnest(array[
  '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000004']::uuid[]) as u
on conflict do nothing;
insert into iam.sessions (id, user_id, created_at) select id, id, now() - interval '1 hour' from iam.users
where email like 'u-10000000-%@test.invalid' on conflict do nothing;

-- The simulator's serial. Real machines are registered the same way.
insert into hrms.attendance_devices (id, org_id, serial, label, office_id, mode) values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001',
   'SIMESSL0001', 'Front door (simulator)', '00000000-0000-4000-8000-0000000000a1', 'https')
on conflict (id) do nothing;

-- PINs 1–4 are linked (any device). The simulator also punches PIN 7, which is
-- deliberately unlinked so it lands in the Unmatched queue (Priya, DEMO-005).
insert into hrms.device_user_links (org_id, serial, pin, employee_id) values
  ('00000000-0000-4000-8000-000000000001', null, '1', '00000000-0000-4000-8000-0000000000e1'),
  ('00000000-0000-4000-8000-000000000001', null, '2', '00000000-0000-4000-8000-0000000000e2'),
  ('00000000-0000-4000-8000-000000000001', null, '3', '00000000-0000-4000-8000-0000000000e3'),
  ('00000000-0000-4000-8000-000000000001', null, '4', '00000000-0000-4000-8000-0000000000e4')
on conflict do nothing;

\set secret '''test-secret-test-secret-test-secret-0001'''
\set hr '''10000000-0000-4000-8000-000000000002'''
\set member '''10000000-0000-4000-8000-000000000004'''

-- Fixtures: auth ids for two seeded fake employees; the ingest secret.
update hrms.employees set auth_user_id = :hr::uuid where employee_code = 'DEMO-002';
update hrms.employees set auth_user_id = :member::uuid where employee_code = 'DEMO-004';
select public.internal_configure_device_ingest(:secret);

-- Isolation: start from the seeded state whatever the local DB has seen
-- (simulator runs, e2e). Triggers are bypassed only inside this rolled-back
-- transaction.
set local session_replication_role = replica;
delete from hrms.device_commands;
delete from hrms.device_attendance_days;
delete from hrms.device_attendance_settings;
delete from hrms.device_punch_photos;
delete from hrms.device_punch_events;
delete from hrms.device_users;
delete from hrms.device_ingest_rejections;
delete from hrms.device_user_links where pin not in ('1', '2', '3', '4') or serial is not null;
update hrms.device_user_links set unlinked_at = null, unlinked_by = null where pin in ('1', '2', '3', '4');
delete from hrms.attendance_devices where serial <> 'SIMESSL0001';
update hrms.attendance_devices set attlog_stamp = null, photo_stamp = null, oplog_stamp = null, token_sha256 = null,
  last_device_time = null, clock_drift_seconds = null, active = true, commands_enabled = false
  where serial = 'SIMESSL0001';
delete from hrms.employees where org_id = '00000000-0000-4000-8000-000000000001' and employee_code like 'EMP-%';
set local session_replication_role = origin;
