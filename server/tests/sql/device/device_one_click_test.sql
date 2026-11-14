-- [web-hrms] Ported from ~/Documents/Projects/november/fingertipssl/supabase/tests/device_one_click_test.sql
-- [web-hrms]   Adapted: people are hired through HRMS provisioning (internal_provision_begin/link),
-- [web-hrms]   removed through set_employee_status, and 'add from Unmatched' links the machine PIN to
-- [web-hrms]   the pending hire before activation (fingertipssl stub RPCs do not exist in HRMS).

-- Automatic machine registration, role-based codes, remove, Unmatched one-click
-- actions and face enrolment. Runs after _prelude.sql (fake DEMO org, rolled back).

\set admin '''10000000-0000-4000-8000-000000000001'''
\set e1 '''00000000-0000-4000-8000-0000000000e1'''
\set e4 '''00000000-0000-4000-8000-0000000000e4'''
\set e5 '''00000000-0000-4000-8000-0000000000e5'''

do $$
declare v_schema text := pg_my_temp_schema()::regnamespace::text;
begin
  set local client_min_messages = error;
  execute format('grant execute on all functions in schema %I to authenticated, service_role', v_schema);
end $$;
set local client_min_messages = notice;

update hrms.employees set auth_user_id = :admin::uuid where id = :e1::uuid;
update hrms.attendance_devices set commands_enabled = true where serial = 'SIMESSL0001';

create function pg_temp.lines(p_emp uuid) returns text[] language sql as $$
  select coalesce(array_agg(hrms.device_command_line(c) order by c.id), array[]::text[])
  from hrms.device_commands c where c.employee_id = p_emp and c.status = 'queued';
$$;
grant execute on function pg_temp.lines(uuid) to authenticated, service_role;

-- HRMS structure that provisioning requires.
insert into hrms.teams (id, org_id, name) values
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-000000000001', 'Ops (fake)');
insert into hrms.shifts (id, org_id, name) values
  ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-000000000001', 'General (fake)');

-- Starts an HRMS hire as p_by (HR by default). The person stays pending.
create function pg_temp.hire_begin(p_code text, p_name text, p_role text default null,
  p_by uuid default '10000000-0000-4000-8000-000000000002') returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := public.internal_provision_begin(p_by, p_by, 'u-' || p_by || '@test.invalid', gen_random_uuid(),
    jsonb_build_object('employee_code', p_code, 'full_name', p_name, 'join_date', '2025-01-01', 'role', p_role,
      'team_id', '00000000-0000-4000-8000-0000000000f1', 'office_id', '00000000-0000-4000-8000-0000000000a1',
      'shift_id', '00000000-0000-4000-8000-0000000000f2'), null);
  return r;
end $$;
-- Completes the hire (login identity created, person becomes active).
create function pg_temp.hire_finish(p_emp uuid, p_by uuid default '10000000-0000-4000-8000-000000000002')
returns uuid language plpgsql as $$
declare v_new uuid := gen_random_uuid(); v_op uuid; v_alias text;
begin
  select provisioning_operation_id, auth_alias into v_op, v_alias from hrms.employees where id = p_emp;
  insert into iam.users (id, email) values (v_new, v_alias);
  perform public.internal_provision_link(p_by, p_by, 'u-' || p_by || '@test.invalid', v_op, v_new);
  return p_emp;
end $$;
create function pg_temp.hire(p_code text, p_name text, p_role text default null,
  p_by uuid default '10000000-0000-4000-8000-000000000002') returns uuid language sql as $$
  select pg_temp.hire_finish((pg_temp.hire_begin(p_code, p_name, p_role, p_by) ->> 'employee_id')::uuid, p_by)
$$;
create function pg_temp.v(p_emp uuid) returns integer language plpgsql security definer as $$
begin return (select version from hrms.employees where id = p_emp); end $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- ------------------------------------------------------- automatic registration
create temp table pend as select (pg_temp.hire_begin('PEND-01', 'Pending Person') ->> 'employee_id')::uuid as id;
select id as pend from pend \gset
select pg_temp.assert(not exists (select 1 from hrms.device_user_links where employee_id = (:'pend')::uuid),
  'a hire whose account is not set up yet gets no PIN');
select pg_temp.hire('KAV-01', 'Kavya New') as kavya \gset
select pg_temp.assert((select array_agg(pin) = array['5'] from hrms.device_user_links where employee_id = :'kavya'::uuid and unlinked_at is null),
  'finishing the hire gives the next free PIN');
select pg_temp.assert(pg_temp.lines(:'kavya'::uuid) = array[
    'C:' || (select id from hrms.device_commands where employee_id = :'kavya'::uuid) || E':DATA UPDATE USERINFO PIN=5\tName=Kavya New\tPri=0'],
  'exactly one add command for the new person');

-- Machine-specific PIN counts as having a PIN: no second PIN on re-send.
update hrms.device_user_links set serial = 'SIMESSL0001' where employee_id = :e4::uuid;
select pg_temp.as_user(:hr::uuid);
select public.sync_all_employee_devices();
reset role;
select pg_temp.assert((select count(*) = 1 from hrms.device_user_links where employee_id = :e4::uuid and unlinked_at is null),
  'someone with a machine-specific PIN is not given a second one');
select pg_temp.assert((select count(*) = 1 from hrms.device_user_links where employee_id = :e5::uuid and unlinked_at is null),
  're-send everyone gives a PIN to an active person who had none');
select pg_temp.assert((select count(*) = 1 from hrms.device_commands where employee_id = :'kavya'::uuid and status = 'queued'),
  're-sending reuses an identical waiting command instead of piling up');
select pg_temp.assert(not exists (select 1 from hrms.device_user_links where employee_id = (:'pend')::uuid),
  're-send everyone skips people who are still pending');

-- A rename through HRMS supersedes the waiting add with the new name.
select pg_temp.as_user(:hr::uuid);
select public.update_employee(:'kavya'::uuid, '{"full_name":"Kavya Rao"}', pg_temp.v(:'kavya'::uuid)) is not null;
reset role;
select pg_temp.assert(pg_temp.lines(:'kavya'::uuid) = array[
    'C:' || (select max(id) from hrms.device_commands where employee_id = :'kavya'::uuid) || E':DATA UPDATE USERINFO PIN=5\tName=Kavya Rao\tPri=0'],
  'a rename leaves exactly one waiting add, with the new name');

select pg_temp.hire('NM-01', 'Next Member') as nextm \gset
select pg_temp.hire('ADM-09', 'New Admin', 'admin', :admin::uuid) as newadmin \gset

-- ---------------------------------------------------------------------- remove
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert(pg_temp.err(format('select public.set_employee_status(%L, ''inactive'', null, ''x'', %s)', :'newadmin', pg_temp.v(:'newadmin'::uuid))) = 'ACCESS_DENIED',
  'HR cannot remove an Admin');
select pg_temp.assert(pg_temp.err(format('select public.set_employee_status(%L, ''inactive'', null, ''x'', %s)', '00000000-0000-4000-8000-0000000000e2', pg_temp.v('00000000-0000-4000-8000-0000000000e2'))) = 'ACCESS_DENIED',
  'nobody can remove themselves');
select public.set_employee_status(:'kavya'::uuid, 'inactive', null, 'Left the company', pg_temp.v(:'kavya'::uuid)) is not null;
reset role;
select pg_temp.assert((select status = 'inactive' from hrms.employees where id = :'kavya'::uuid)
                      and not exists (select 1 from hrms.device_user_links where employee_id = :'kavya'::uuid and unlinked_at is null),
  'remove deactivates the person and unlinks their PIN');
select pg_temp.assert(pg_temp.lines(:'kavya'::uuid) = array[
    'C:' || (select max(id) from hrms.device_commands where employee_id = :'kavya'::uuid) || ':DATA DELETE USERINFO PIN=5'],
  'and deletes them from the machine (the waiting add is superseded)');
select pg_temp.assert((select count(*) = 1 from hrms.audit_logs where action = 'device_user.unlink' and target_id in
                         (select id from hrms.device_user_links where employee_id = :'kavya'::uuid))
                      and (select count(*) = 1 from hrms.audit_logs where action = 'employee.status_inactive' and target_id = :'kavya'::uuid),
  'removal and the PIN release are audited');

-- Restoring gives a working PIN again (the freed PIN may be reused by now).
select pg_temp.as_user(:hr::uuid);
select public.set_employee_status(:'kavya'::uuid, 'active', null, 'Rejoined', pg_temp.v(:'kavya'::uuid)) is not null;
reset role;
select pg_temp.assert((select count(*) = 1 from hrms.device_user_links where employee_id = :'kavya'::uuid and unlinked_at is null),
  'restoring someone gives them a PIN again');

-- ------------------------------------------------------------------- Unmatched
insert into hrms.device_users (org_id, serial, pin, name) values
  ('00000000-0000-4000-8000-000000000001', 'SIMESSL0001', '40', 'Machine Only'),
  ('00000000-0000-4000-8000-000000000001', 'SIMESSL0001', '41', 'Leftover Test');
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert((select count(*) = 2 from jsonb_array_elements(public.list_unmatched_device_pins() -> 'data') r
                       where r ->> 'pin' in ('40', '41') and (r ->> 'on_machine')::boolean and (r ->> 'can_remove')::boolean),
  'Unmatched lists machine users nobody is linked to');
-- One click on Unmatched = HRMS hire with the machine's name, the machine PIN
-- linked while the hire is pending, then the account is finished.
create temp table cp as select pg_temp.hire_begin('MO-01', 'Machine Only') as d;
select d ->> 'employee_id' as mo from cp \gset
select public.claim_device_pin_for_hire((:'mo')::uuid, 'SIMESSL0001', '40');
select pg_temp.assert(pg_temp.err(format('select public.claim_device_pin_for_hire(%L, ''SIMESSL0001'', ''40'')',
                        (:'pend')::uuid)) = 'CONFLICT',
  'a machine user already linked cannot be claimed by a second new hire');
select pg_temp.assert(pg_temp.err(format('select public.claim_device_pin_for_hire(%L, ''SIMESSL0001'', ''41'')',
                        (:'mo')::uuid)) = 'CONFLICT',
  'a new hire cannot claim two machine users');
select pg_temp.assert(pg_temp.err(format('select public.claim_device_pin_for_hire(%L, ''SIMESSL0001'', ''41'')', :'nextm')) = 'VALIDATION_FAILED',
  'an already active person cannot use the new-hire claim (use link instead)');
select pg_temp.assert(pg_temp.err(format('select public.claim_device_pin_for_hire(%L, ''NOPE'', ''41'')', (:'pend')::uuid)) = 'VALIDATION_FAILED'
                      and pg_temp.err(format('select public.claim_device_pin_for_hire(%L, ''SIMESSL0001'', ''4;1'')', (:'pend')::uuid)) = 'VALIDATION_FAILED',
  'unknown machine and malformed PIN are refused');
select pg_temp.assert(pg_temp.err($$select public.remove_machine_user('SIMESSL0001', '40')$$) = 'VALIDATION_FAILED',
  'a linked PIN cannot be removed from Unmatched (remove the employee instead)');
select public.remove_machine_user('SIMESSL0001', '41');
reset role;
select pg_temp.hire_finish((select (d ->> 'employee_id')::uuid from cp));
update cp set d = jsonb_build_object('id', d ->> 'employee_id');
select pg_temp.assert((select e.full_name = 'Machine Only' and e.status = 'active' from hrms.employees e where e.id = (select (d ->> 'id')::uuid from cp)),
  'one click on Unmatched creates the employee with the machine''s name');
select pg_temp.assert((select array_agg(pin) = array['40'] from hrms.device_user_links
                       where employee_id = (select (d ->> 'id')::uuid from cp) and unlinked_at is null),
  'and links that PIN (no new PIN is made)');
select pg_temp.assert((select array_agg(kind || ':' || pin) = array['user_upsert:40'] from hrms.device_commands
                       where employee_id = (select (d ->> 'id')::uuid from cp)),
  'and pushes the name to the machine once');
select pg_temp.assert(exists (select 1 from hrms.device_commands where pin = '41' and kind = 'user_delete' and reason = 'remove'
                              and status = 'queued' and employee_id is null),
  'a leftover machine user can be removed from the machine');

-- Linking a PIN on Unmatched pushes the name.
insert into hrms.device_users (org_id, serial, pin, name) values
  ('00000000-0000-4000-8000-000000000001', 'SIMESSL0001', '42', 'x');
select pg_temp.as_user(:hr::uuid);
select public.link_device_user('42', :'nextm'::uuid, null);
reset role;
select pg_temp.assert(exists (select 1 from hrms.device_commands where pin = '42' and kind = 'user_upsert'
                              and payload ->> 'name' = 'Next Member' and status = 'queued'),
  'linking a PIN puts the person''s name on the machine');

-- ------------------------------------------------------------------------ face
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert(pg_temp.err($$select public.enroll_device_face('00000000-0000-4000-8000-0000000000e1', 'SIMESSL0001', '7')$$) = 'VALIDATION_FAILED',
  'unknown face types are refused');
create temp table fc as select public.enroll_device_face(:e1::uuid, 'SIMESSL0001') -> 'data' as d;
reset role;
select pg_temp.assert(hrms.device_command_line((select c from hrms.device_commands c where id = (select (d ->> 'command_id')::bigint from fc)))
                      = 'C:' || (select d ->> 'command_id' from fc) || E':ENROLL_BIO TYPE=9\tPIN=1\tRETRY=3\tOVERWRITE=1',
  'face enrolment sends ENROLL_BIO (visible-light face) for the person''s PIN');
select pg_temp.assert(exists (select 1 from hrms.device_commands where pin = '1' and kind = 'user_upsert' and status = 'queued'
                              and id < (select (d ->> 'command_id')::bigint from fc)),
  'a person not yet on the machine is added before face enrolment (a waiting add is reused, not duplicated)');
select pg_temp.assert((select count(*) = 1 from hrms.device_commands where pin = '1' and kind = 'user_upsert' and status = 'queued'),
  'face enrolment never queues a second add for the same person');
select pg_temp.assert(pg_temp.err($$insert into hrms.device_commands (org_id, serial, kind, pin, payload, reason)
  values ('00000000-0000-4000-8000-000000000001', 'SIMESSL0001', 'enroll_face', '1', '{"face_type":"9; reboot","overwrite":"1"}', 'enroll')$$)
  like '%device_commands_check%', 'the face payload shape is enforced by the table');
update hrms.device_commands set status = 'done', completed_at = now() where id = (select (d ->> 'command_id')::bigint from fc);
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert((select s ->> 'face_enrolled_at' is not null and s ? 'photo_punch_id'
                       from jsonb_array_elements(public.list_employee_device_status() -> 'data') s
                       where s ->> 'employee_id' = '00000000-0000-4000-8000-0000000000e1'),
  'employee status shows the face enrolment and the photo slot');
reset role;

-- --------------------------------------------------------------------- members
select pg_temp.as_user(:member::uuid);
select pg_temp.assert(pg_temp.err($$select public.set_employee_status('00000000-0000-4000-8000-0000000000e5', 'inactive', null, 'x', 1)$$) = 'ACCESS_DENIED'
                      and pg_temp.err($$select public.enroll_device_face('00000000-0000-4000-8000-0000000000e5', 'SIMESSL0001')$$) = 'ACCESS_DENIED'
                      and pg_temp.err($$select public.remove_machine_user('SIMESSL0001', '41')$$) = 'ACCESS_DENIED'
                      and pg_temp.err($$select public.link_device_user('41', '00000000-0000-4000-8000-0000000000e4', null)$$) = 'ACCESS_DENIED'
                      and pg_temp.err(format('select public.claim_device_pin_for_hire(%L, ''SIMESSL0001'', ''41'')', (:'pend')::uuid)) = 'ACCESS_DENIED'
                      and pg_temp.err($$select public.sync_all_employee_devices()$$) = 'ACCESS_DENIED',
  'members cannot use any of it');
reset role;

\echo 'ALL ONE-CLICK TESTS PASSED'
rollback;
