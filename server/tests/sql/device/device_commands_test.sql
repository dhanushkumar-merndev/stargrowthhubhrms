-- [web-hrms] Ported from ~/Documents/Projects/november/fingertipssl/supabase/tests/device_commands_test.sql
-- [web-hrms]   Adapted: rename/deactivate go through HRMS update_employee / set_employee_status.

-- Machine command channel: off by default, Admin switch, PIN assignment,
-- the three allowed command shapes, delivery/ack/retry/expiry, enrolment,
-- employee rename/deactivate sync, and access control.
-- Runs after _prelude.sql (pnpm db:test).

\set admin '''10000000-0000-4000-8000-000000000001'''
\set dev '''00000000-0000-4000-8000-0000000000d1'''
update hrms.employees set auth_user_id = :admin::uuid where employee_code = 'DEMO-001';

create function pg_temp.poll(p_secret text, p_serial text default 'SIMESSL0001') returns jsonb language sql as $$
  select public.internal_device_poll(p_secret, p_serial, null, 'ip', '{}'::jsonb);
$$;
create function pg_temp.lines(p jsonb) returns text[] language sql as $$
  select coalesce(array_agg(x order by o), array[]::text[]) from jsonb_array_elements_text(p -> 'commands') with ordinality t(x, o);
$$;
-- The command text after "C:<id>:".
create function pg_temp.bodies(p jsonb) returns text[] language sql as $$
  select coalesce(array_agg(regexp_replace(x, '^C:\d+:', '') order by o), array[]::text[])
  from jsonb_array_elements_text(p -> 'commands') with ordinality t(x, o);
$$;
do $$ begin
  execute format('grant execute on all functions in schema %I to authenticated, service_role', pg_my_temp_schema()::regnamespace::text);
end $$;

-- ------------------------------------------------------------------ privileges
select pg_temp.assert(not has_table_privilege('authenticated', 'hrms.device_commands', 'select'),
  'authenticated has no table access to commands');
select pg_temp.assert(not has_function_privilege('authenticated',
  'public.internal_device_poll(text,text,text,text,jsonb)', 'execute'), 'users cannot poll as a device');
select pg_temp.assert(not has_function_privilege('authenticated',
  'public.internal_device_command_results(text,text,text,text,jsonb)', 'execute'), 'users cannot post device results');
select pg_temp.assert(pg_temp.err($$insert into hrms.device_commands (org_id, serial, kind, pin, reason)
  values ('00000000-0000-4000-8000-000000000001', 'SIMESSL0001', 'reboot', '1', 'sync')$$) like '%check%',
  'no other command kind can exist');
select pg_temp.assert(pg_temp.err(format($$insert into hrms.device_commands (org_id, serial, kind, pin, payload, reason)
  values ('00000000-0000-4000-8000-000000000001', 'SIMESSL0001', 'user_upsert', '1', %L, 'sync')$$,
  jsonb_build_object('name', E'Evil\tPri=14', 'privilege', '0'))) like '%check%',
  'a name with a tab can never be stored, so it can never inject a field');
select pg_temp.assert(hrms.device_display_name(E'  Asha\tR\nRao  ') = 'Asha R Rao'
                      and char_length(hrms.device_display_name(repeat('x', 40))) = 24,
  'machine names are single-line, trimmed, max 24 characters');

-- -------------------------------------------------------------- off by default
select pg_temp.assert(pg_temp.poll(:secret) = '{"ok": true, "commands": []}'::jsonb,
  'a machine with commands off is only a heartbeat');
select pg_temp.assert(not (pg_temp.poll(:secret, 'NOPE0001') ->> 'ok')::boolean, 'an unknown serial is refused');

select pg_temp.as_user(:hr::uuid);
select pg_temp.assert((public.assign_device_pin('00000000-0000-4000-8000-0000000000e5') -> 'data' ->> 'queued')::int = 0,
  'assigning a PIN works with commands off but queues nothing');
select pg_temp.assert(pg_temp.err(format($$select public.set_device_commands(%L, true)$$, :dev)) = 'ACCESS_DENIED',
  'HR cannot turn commands on');
select pg_temp.assert(pg_temp.err($$select public.enroll_device_fingerprint('00000000-0000-4000-8000-0000000000e5', 'SIMESSL0001', 6)$$)
                      = 'VALIDATION_FAILED', 'enrolment is refused while commands are off');
select pg_temp.as_user(:admin::uuid);
select public.set_device_commands(:dev::uuid, true);
reset role;
select pg_temp.assert((select commands_enabled from hrms.attendance_devices where serial = 'SIMESSL0001'), 'Admin turns commands on');
select pg_temp.assert((select count(*) = 1 from hrms.audit_logs where action = 'device.commands' and classification = 'security'
                       and created_at = now()), 'the switch is a security audit event');

-- ------------------------------------------------------------- PIN assignment
select pg_temp.assert((select array_agg(pin) = array['5'] from hrms.device_user_links
                       where employee_id = '00000000-0000-4000-8000-0000000000e5' and unlinked_at is null and serial is null),
  'the next free PIN (after 1–4) was assigned');
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert((select (r ->> 'pin') = '5' and not (r ->> 'new')::boolean and (r ->> 'queued')::int = 1
                       from (select public.assign_device_pin('00000000-0000-4000-8000-0000000000e5') -> 'data' r) s),
  'assigning again keeps the same PIN and pushes the person to the machine');
reset role;

-- ------------------------------------------------------- delivery and results
select set_config('test.p', pg_temp.poll(:secret)::text, true);
select pg_temp.assert(pg_temp.bodies(current_setting('test.p')::jsonb) = array[E'DATA UPDATE USERINFO PIN=5\tName=Priya Menon (fake)\tPri=0'],
  'the machine receives exactly the upsert line');
select pg_temp.assert((select status = 'sent' and attempts = 1 from hrms.device_commands where pin = '5' and kind = 'user_upsert'),
  'it is marked sent');
select pg_temp.assert(pg_temp.lines(pg_temp.poll(:secret)) = array[]::text[], 'a just-sent command is not sent twice');

-- Another machine cannot complete this machine's command.
insert into hrms.attendance_devices (org_id, serial, label, active) values
  ('00000000-0000-4000-8000-000000000001', 'SIMESSL0002', 'Second', true);
select pg_temp.assert((public.internal_device_command_results(:secret, 'SIMESSL0002', null, 'ip',
                        jsonb_build_array(jsonb_build_object('id', (select id from hrms.device_commands where pin = '5'), 'return', 0)))
                       ->> 'updated')::int = 0,
  'results are scoped to the machine that received the command');
select public.internal_device_command_results(:secret, 'SIMESSL0001', null, 'ip',
  jsonb_build_array(jsonb_build_object('id', (select id from hrms.device_commands where pin = '5' and kind = 'user_upsert'), 'return', 0)));
select pg_temp.assert((select status = 'done' and return_code = 0 from hrms.device_commands where pin = '5' and kind = 'user_upsert'),
  'return 0 marks the command done');

select pg_temp.assert((select name = 'Priya Menon (fake)' and not is_device_admin from hrms.device_users
                       where serial = 'SIMESSL0001' and pin = '5'),
  'a user the machine accepted appears on the machine roster');

-- ------------------------------------------------------------------ enrolment
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert(pg_temp.err($$select public.enroll_device_fingerprint('00000000-0000-4000-8000-0000000000e5', 'SIMESSL0001', 12)$$)
                      = 'VALIDATION_FAILED', 'finger must be 0–9');
select pg_temp.assert(pg_temp.err($$select public.enroll_device_fingerprint('00000000-0000-4000-8000-0000000000e6', 'SIMESSL0001', 6)$$)
                      = 'VALIDATION_FAILED', 'inactive employees cannot be enrolled');
select public.enroll_device_fingerprint('00000000-0000-4000-8000-0000000000e5', 'SIMESSL0001', 6, false);
-- Rahul (PIN 4) is not on the machine yet: the user is pushed first.
select public.enroll_device_fingerprint('00000000-0000-4000-8000-0000000000e4', 'SIMESSL0001', 1, true);
reset role;
select pg_temp.assert((select count(*) = 2 from hrms.audit_logs where action = 'device_command.enroll' and created_at = now()),
  'enrolment requests are audited');
select pg_temp.assert(pg_temp.bodies(pg_temp.poll(:secret)) = array[
    E'ENROLL_FP PIN=5\tFID=6\tRETRY=3\tOVERWRITE=0',
    E'DATA UPDATE USERINFO PIN=4\tName=Rahul Nair (fake)\tPri=0',
    E'ENROLL_FP PIN=4\tFID=1\tRETRY=3\tOVERWRITE=1'],
  'enrol lines in order; an unknown user is created before enrolment');

-- -------------------------------------------------------- retry, fail, expire
update hrms.device_commands set sent_at = now() - interval '3 minutes' where status = 'sent';
select pg_temp.assert(pg_temp.bodies(pg_temp.poll(:secret)) = array[E'DATA UPDATE USERINFO PIN=4\tName=Rahul Nair (fake)\tPri=0'],
  'an unanswered user command is re-sent after 2 minutes; enrolment is never re-sent');
update hrms.device_commands set attempts = 3, sent_at = now() - interval '3 minutes' where kind = 'user_upsert' and pin = '4';
update hrms.device_commands set sent_at = now() - interval '11 minutes' where kind = 'enroll_fingerprint' and pin = '5';
select pg_temp.poll(:secret);
select pg_temp.assert((select status from hrms.device_commands where kind = 'user_upsert' and pin = '4') = 'failed'
                      and (select status from hrms.device_commands where kind = 'enroll_fingerprint' and pin = '5') = 'failed'
                      and (select status from hrms.device_commands where kind = 'enroll_fingerprint' and pin = '4') = 'sent',
  'after 3 tries / 10 minutes without an answer a command fails');
select public.internal_device_command_results(:secret, 'SIMESSL0001', null, 'ip',
  jsonb_build_array(jsonb_build_object('id', (select id from hrms.device_commands where kind = 'enroll_fingerprint' and pin = '4'), 'return', -1002)));
select pg_temp.assert((select status = 'failed' and return_code = -1002 from hrms.device_commands where kind = 'enroll_fingerprint' and pin = '4'),
  'a non-zero return marks it failed and keeps the code');

-- --------------------------------------------- employee changes follow them
select version as v5 from hrms.employees where id = '00000000-0000-4000-8000-0000000000e5' \gset
select pg_temp.as_user(:hr::uuid);
select public.update_employee('00000000-0000-4000-8000-0000000000e5', '{"full_name":"Priya M"}', :v5) is not null;
reset role;
select pg_temp.assert((select payload ->> 'name' = 'Priya M' and reason = 'employee_changed' and created_by = '00000000-0000-4000-8000-0000000000e2' and status = 'queued'
                       from hrms.device_commands where pin = '5' and kind = 'user_upsert' order by id desc limit 1),
  'a rename is pushed to the machine, credited to the HR user who made it');
select version as v5 from hrms.employees where id = '00000000-0000-4000-8000-0000000000e5' \gset
select pg_temp.as_user(:hr::uuid);
select public.set_employee_status('00000000-0000-4000-8000-0000000000e5', 'inactive', null, 'Left the company', :v5) is not null;
reset role;
select pg_temp.assert((select array_agg(kind || ':' || status || ':' || reason order by id) from hrms.device_commands where pin = '5')
                      @> array['user_upsert:cancelled:employee_changed', 'user_delete:queued:remove'],
  'removing from the organisation deletes the person from the machine and supersedes the waiting rename');
select pg_temp.assert(not exists (select 1 from hrms.device_user_links where pin = '5' and unlinked_at is null),
  'and frees their PIN');

-- A machine admin keeps their machine privilege when pushed.
insert into hrms.device_users (org_id, serial, pin, name, is_device_admin) values
  ('00000000-0000-4000-8000-000000000001', 'SIMESSL0001', '1', 'ASHA', true);
select pg_temp.as_user(:hr::uuid);
select public.sync_employee_devices('00000000-0000-4000-8000-0000000000e1');
reset role;
select pg_temp.assert((select payload ->> 'privilege' = '14' from hrms.device_commands where pin = '1' order by id desc limit 1),
  'a machine admin is pushed with Pri=14');

-- ------------------------------------------------------------ cancel and off
select (select id from hrms.device_commands where pin = '1' order by id desc limit 1) as waiting_id,
       (select id from hrms.device_commands where status = 'done' limit 1) as done_id \gset
select pg_temp.as_user(:hr::uuid);
select public.cancel_device_command(:waiting_id);
select pg_temp.assert(pg_temp.err('select public.cancel_device_command(' || :done_id || ')') = 'VALIDATION_FAILED',
  'only a waiting command can be cancelled');
select pg_temp.assert(jsonb_array_length(public.list_device_commands(null, 50) -> 'data') > 0
                      and jsonb_array_length(public.list_employee_device_status() -> 'data') = 6,
  'HR can list commands and per-employee machine status');
select pg_temp.assert((select (d ->> 'commands_enabled')::boolean from jsonb_array_elements(public.list_attendance_devices() -> 'data') d
                       where d ->> 'serial' = 'SIMESSL0001'), 'the devices list shows the command switch');
select pg_temp.as_user(:admin::uuid);
select public.set_device_commands(:dev::uuid, false);
reset role;
select pg_temp.assert(not exists (select 1 from hrms.device_commands where serial = 'SIMESSL0001' and status in ('queued', 'sent')),
  'turning commands off cancels everything waiting');
select pg_temp.assert(pg_temp.poll(:secret) = '{"ok": true, "commands": []}'::jsonb, 'and the machine gets nothing more');

-- -------------------------------------------------------------------- members
select pg_temp.as_user(:member::uuid);
select pg_temp.assert(pg_temp.err($$select public.assign_device_pin('00000000-0000-4000-8000-0000000000e4')$$) = 'ACCESS_DENIED',
  'members cannot assign PINs');
select pg_temp.assert(pg_temp.err('select public.list_device_commands(null, 10)') = 'ACCESS_DENIED', 'members cannot list commands');
reset role;

\echo 'ALL DEVICE COMMAND TESTS PASSED'
rollback;
