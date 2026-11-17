-- Machine clock sync: packed time, auto-queue on drift, rate limit, clearing
-- drift after a successful set, and backing off after a rejection.
-- Runs after _prelude.sql (pnpm db:test).

\set dev '''00000000-0000-4000-8000-0000000000d1'''

create function pg_temp.poll() returns jsonb language sql as $$
  select public.internal_device_poll('test-secret-test-secret-test-secret-0001', 'SIMESSL0001', null, 'ip', '{}'::jsonb);
$$;
create function pg_temp.bodies(p jsonb) returns text[] language sql as $$
  select coalesce(array_agg(regexp_replace(x, '^C:\d+:', '') order by o), array[]::text[])
  from jsonb_array_elements_text(p -> 'commands') with ordinality t(x, o);
$$;

-- ------------------------------------------------------------------ packing
select pg_temp.assert(hrms.zk_packed_time('2000-01-01 00:00:00') = 0, '2000-01-01 midnight packs to 0');
select pg_temp.assert(hrms.zk_packed_time('2018-02-22 14:54:54') = 583080894,
  'packs like the firmware (the documented example value is 2018-02-22 14:54:54)');
select pg_temp.assert(hrms.zk_packed_time('2026-11-17 16:13:05') =
  ((26 * 12 * 31 + 10 * 31 + 16) * 86400 + 16 * 3600 + 13 * 60 + 5), 'months count as 31 days');

-- ------------------------------------------------------------ nothing to fix
update hrms.attendance_devices set commands_enabled = true, clock_drift_seconds = 20 where serial = 'SIMESSL0001';
select pg_temp.assert(pg_temp.bodies(pg_temp.poll()) = array[]::text[], 'a clock within a minute is left alone');
update hrms.attendance_devices set commands_enabled = false, clock_drift_seconds = -19802 where serial = 'SIMESSL0001';
select pg_temp.assert(pg_temp.bodies(pg_temp.poll()) = array[]::text[], 'nothing is sent while commands are off');
select pg_temp.assert(not exists (select 1 from hrms.device_commands where kind = 'set_time'), 'and nothing is queued');

-- ------------------------------------------------------------- drift -> fix
update hrms.attendance_devices set commands_enabled = true where serial = 'SIMESSL0001';
select pg_temp.assert((select b[1] from pg_temp.bodies(pg_temp.poll()) b) ~ '^SET OPTION DateTime=\d+$',
  'a machine 5.5 h out is sent SET OPTION DateTime');
select pg_temp.assert(abs((select regexp_replace(line, '^.*=', '')::bigint
                             from (select hrms.device_command_line(c) line from hrms.device_commands c where kind = 'set_time') s)
                          - hrms.zk_packed_time(now() at time zone 'Asia/Kolkata')) <= 2,
  'the value is the organisation''s local time right now');
select pg_temp.assert(pg_temp.bodies(pg_temp.poll()) = array[]::text[], 'it is not sent twice while waiting for the answer');

select public.internal_device_command_results('test-secret-test-secret-test-secret-0001', 'SIMESSL0001', null, 'ip',
  jsonb_build_array(jsonb_build_object('id', (select id from hrms.device_commands where kind = 'set_time'), 'return', 0)));
select pg_temp.assert((select clock_drift_seconds from hrms.attendance_devices where serial = 'SIMESSL0001') is null,
  'a successful set clears the drift until the next punch measures it');

-- ------------------------------------------------------------ rate limiting
update hrms.attendance_devices set clock_drift_seconds = -19802 where serial = 'SIMESSL0001';
select pg_temp.assert(pg_temp.bodies(pg_temp.poll()) = array[]::text[], 'no second attempt within 10 minutes');
update hrms.device_commands set created_at = now() - interval '11 minutes' where kind = 'set_time';
select pg_temp.assert((select b[1] from pg_temp.bodies(pg_temp.poll()) b) like 'SET OPTION DateTime=%',
  'still out after 10 minutes: corrected again');

-- -------------------------------------------------------------- rejection
select public.internal_device_command_results('test-secret-test-secret-test-secret-0001', 'SIMESSL0001', null, 'ip',
  jsonb_build_array(jsonb_build_object('id', (select max(id) from hrms.device_commands where kind = 'set_time'), 'return', -1002)));
update hrms.device_commands set created_at = now() - interval '11 minutes' where kind = 'set_time';
select pg_temp.assert(pg_temp.bodies(pg_temp.poll()) = array[]::text[], 'a machine that rejects the command is left alone for 6 hours');

\echo 'ALL DEVICE CLOCK TESTS PASSED'
rollback;
