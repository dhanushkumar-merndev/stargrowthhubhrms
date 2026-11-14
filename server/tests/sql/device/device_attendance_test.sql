-- [web-hrms] Ported from ~/Documents/Projects/november/fingertipssl/supabase/tests/device_attendance_test.sql
-- [web-hrms]   Adapted: storage checks -> R2 (photos are not in Postgres storage);
-- [web-hrms]   stub employee admin -> HRMS role_grants checks (HRMS suites cover employee admin).

-- Device ingest, linking, photos, device management and employee admin.
-- Runs after _prelude.sql (pnpm db:test).

-- ------------------------------------------------------------------ privileges
select pg_temp.assert(not has_table_privilege('authenticated', 'hrms.device_punch_events', 'select'),
  'authenticated has no table access to hrms.device_punch_events');
select pg_temp.assert(not has_schema_privilege('authenticated', 'hrms', 'usage'),
  'authenticated has no usage on schema hrms');
select pg_temp.assert(not has_function_privilege('authenticated',
  'public.internal_ingest_device_punches(text,text,text,text,jsonb,text)', 'execute'),
  'authenticated cannot call the ingest RPC');
select pg_temp.assert(not has_function_privilege('anon', 'public.list_device_punches(jsonb)', 'execute'),
  'anon cannot call dashboard RPCs');
select pg_temp.assert(not has_table_privilege('authenticated', 'hrms.device_punch_photos', 'select')
                      and not has_table_privilege('anon', 'hrms.device_punch_photos', 'select'),
  'photo metadata is not readable by API roles (files are private objects in R2)');

-- ---------------------------------------------------------------------- ingest
select pg_temp.as_service();
create temp table batch as select jsonb_build_array(
  jsonb_build_object('line', 1, 'pin', '4', 'device_time', pg_temp.lt(7200), 'status', '1', 'verify', '1'),
  jsonb_build_object('line', 2, 'pin', '4', 'device_time', pg_temp.lt(7170), 'status', '1', 'verify', '1'),
  jsonb_build_object('line', 3, 'pin', '4', 'device_time', pg_temp.lt(1800), 'status', '0', 'verify', '15'),
  jsonb_build_object('line', 4, 'pin', '7', 'device_time', pg_temp.lt(600), 'status', '0', 'verify', '15'),
  jsonb_build_object('line', 5, 'error', 'too_few_fields', 'raw', 'garbage'),
  jsonb_build_object('line', 6, 'pin', '4', 'device_time', '2099-01-01 09:00:00', 'status', '0', 'verify', '1'),
  jsonb_build_object('line', 7, 'pin', '4', 'device_time', '2026-02-30 09:00:00', 'status', '0', 'verify', '1'),
  jsonb_build_object('line', 8, 'pin', '4;drop', 'device_time', pg_temp.lt(60), 'status', '0', 'verify', '1')
) as b;
grant select on batch to service_role;
create temp table r1 as
  select public.internal_ingest_device_punches(:secret, 'SIMESSL0001', null, 'iphash', b, '42') as res from batch;
create temp table r2 as
  select public.internal_ingest_device_punches(:secret, 'SIMESSL0001', null, 'iphash', b, '43') as res from batch;
reset role;

select pg_temp.assert((select (res->>'ok')::boolean from r1), 'allowlisted serial + secret accepted');
select pg_temp.assert((select res->>'processed' = '8' and res->>'accepted' = '4' and res->>'rejected' = '4'
                              and res->>'duplicates' = '0' from r1),
  'first batch: 8 processed = 4 accepted + 4 rejected (malformed, future, impossible date, bad pin)');
select pg_temp.assert((select res->>'accepted' = '0' and res->>'duplicates' = '4' from r2),
  'resending the same batch is fully deduplicated');
select pg_temp.assert((select count(*) = 4 from hrms.device_punch_events), 'exactly 4 rows stored');
select pg_temp.assert((select array_agg(code order by code) from hrms.device_ingest_rejections where serial = 'SIMESSL0001')
                      @> array['bad_pin', 'bad_time', 'future_time', 'malformed_line'],
  'each refused line is logged with its reason');
select pg_temp.assert((select detail->>'device_time' = '2099-01-01 09:00:00' from hrms.device_ingest_rejections
                       where code = 'future_time' limit 1),
  'refused punch keeps pin/time in the log for recovery');
select pg_temp.assert((select attlog_stamp = 43 and last_punch_received_at is not null and clock_drift_seconds is not null
                       from hrms.attendance_devices where serial = 'SIMESSL0001'),
  'device cursor, last punch and drift updated');

select pg_temp.assert((
  select array_agg(action_effective || ':' || counted order by device_time)
  from hrms.device_punch_events where pin = '4') = array['IN:true', 'IN:false', 'OUT:true'],
  'IN/OUT inferred from order; repeat scan within 60s kept but not counted');
select pg_temp.assert((select (integrity->>'claimed_status') = '1' from hrms.device_punch_events
                       where pin = '4' order by device_time limit 1),
  'device status byte stored only as an untrusted claim');
select pg_temp.assert((select employee_id = '00000000-0000-4000-8000-0000000000e4' and source = 'device'
                       from hrms.device_punch_events where pin = '4' limit 1),
  'linked PIN matched to its employee; source = device');
select pg_temp.assert((select employee_id is null from hrms.device_punch_events where pin = '7'),
  'unlinked PIN stays unmatched');
select pg_temp.assert((select count(*) >= 4 from hrms.live_events where kind = 'device.punch' and audience = 'hr_admin'
                       and org_id = '00000000-0000-4000-8000-000000000001'),
  'inserts publish a live event for HR/Admin of the org');
select pg_temp.assert(not exists (select 1 from hrms.live_events where kind = 'device.punch'
                                  and (payload ? 'pin' or payload ? 'photo_path' or payload - 'id' - 'op' <> '{}'::jsonb)),
  'live events carry ids only (no PIN, no photo path)');

-- ------------------------------------------------------------ device rejection
select pg_temp.as_service();
create temp table r3 as select
  public.internal_ingest_device_punches(:secret, 'NOTREGISTERED9', null, 'iphash2',
    jsonb_build_array(jsonb_build_object('pin', '4', 'device_time', pg_temp.lt(5))), null) as unknown,
  public.internal_ingest_device_punches('wrong-secret', 'SIMESSL0001', null, 'iphash2',
    jsonb_build_array(jsonb_build_object('pin', '4', 'device_time', pg_temp.lt(5))), null) as bad_secret,
  public.internal_device_gate(:secret, 'NOTREGISTERED9', null, 'iphash2', 'getrequest') as gate_unknown,
  public.internal_device_gate(:secret, 'SIMESSL0001', null, 'iphash2', 'cdata', '{"pushver":"2.4.1"}') as gate_ok;
reset role;
select pg_temp.assert((select unknown->>'code' = 'unknown_serial' and bad_secret->>'code' = 'bad_secret'
                              and gate_unknown->>'code' = 'unknown_serial' and (gate_ok->>'ok')::boolean
                              and gate_ok->>'attlog_stamp' = '43' from r3),
  'unknown serial and wrong secret refused; gate returns cursor for known device');
select pg_temp.assert((select count(*) = 4 from hrms.device_punch_events), 'refused requests stored no punches');
select pg_temp.assert((select count(*) = 2 from hrms.device_ingest_rejections where serial = 'NOTREGISTERED9'),
  'unknown serial attempts are logged');

update hrms.attendance_devices set token_sha256 = hrms.sha256_hex('device-token-1') where serial = 'SIMESSL0001';
select pg_temp.as_service();
create temp table r4 as select
  public.internal_device_gate(:secret, 'SIMESSL0001', null, 'iphash3', 'cdata') as no_token,
  public.internal_device_gate(:secret, 'SIMESSL0001', 'device-token-1', 'iphash3', 'cdata') as with_token;
reset role;
update hrms.attendance_devices set token_sha256 = null where serial = 'SIMESSL0001';
select pg_temp.assert((select no_token->>'code' = 'bad_token' and (with_token->>'ok')::boolean from r4),
  'a configured device token is mandatory');

-- -------------------------------------------------------------------- guards
select pg_temp.assert(pg_temp.err('update hrms.device_punch_events set device_time = now()') like '%immutable%',
  'device-supplied fields are immutable');
select pg_temp.assert(pg_temp.err('delete from hrms.device_punch_events') like '%append-only%',
  'punches cannot be deleted');

-- --------------------------------------------------------------- dashboard RPCs
select pg_temp.as_user(:member::uuid);
select pg_temp.assert(pg_temp.err('select public.list_unmatched_device_pins()') = 'ACCESS_DENIED',
  'a member cannot see the unmatched queue');
select pg_temp.assert(pg_temp.err($$select public.link_device_user('7', '00000000-0000-4000-8000-0000000000e4')$$) = 'ACCESS_DENIED',
  'a member cannot link PINs');
select pg_temp.assert(pg_temp.err('select public.list_device_ingest_rejections()') = 'ACCESS_DENIED',
  'a member cannot see rejections');
select pg_temp.assert((select jsonb_array_length(public.list_device_punches()->'data') = 3), 'a member sees only their own 3 punches');
select pg_temp.assert((select bool_and(x->'pin' = 'null'::jsonb and x->'integrity' = 'null'::jsonb)
                       from jsonb_array_elements(public.list_device_punches()->'data') x),
  'a member does not see PIN or integrity detail');
select pg_temp.assert(not public.device_feed_can_listen('hrms:device-punches:00000000-0000-4000-8000-000000000001'),
  'a member cannot join the live feed');
reset role;

select pg_temp.as_user(:hr::uuid);
select pg_temp.assert(public.device_feed_can_listen('hrms:device-punches:00000000-0000-4000-8000-000000000001'),
  'HR can join their org live feed');
select pg_temp.assert(not public.device_feed_can_listen('hrms:device-punches:someone-else'),
  'HR cannot join another topic');
select pg_temp.assert((select jsonb_array_length(public.list_device_punches()->'data') = 4), 'HR sees the whole org feed');
select pg_temp.assert((select (public.list_unmatched_device_pins()->'data'->0->>'pin') = '7'), 'PIN 7 is in the unmatched queue');
create temp table r5 as select public.link_device_user('7', '00000000-0000-4000-8000-0000000000e5') as res;
create temp table r6 as select public.link_device_user('7', '00000000-0000-4000-8000-0000000000e5') as res;
select pg_temp.assert((select res->'data'->>'attached' = '1' from r5), 'linking PIN 7 attached its punch');
select pg_temp.assert((select res->'data'->>'link_id' = (select res->'data'->>'link_id' from r5) from r6),
  'linking the same PIN to the same person again is idempotent');
select pg_temp.assert((select jsonb_array_length(public.list_unmatched_device_pins()->'data') = 0), 'unmatched queue now empty');
select pg_temp.assert(pg_temp.err($$select public.link_device_user('7', '00000000-0000-4000-8000-0000000000e6')$$) = 'VALIDATION_FAILED',
  'cannot link a PIN to an inactive employee');
reset role;
select pg_temp.assert((select employee_id = '00000000-0000-4000-8000-0000000000e5' and action_effective = 'IN'
                       from hrms.device_punch_events where pin = '7'),
  'attached punch now belongs to the employee, sequenced IN');
select pg_temp.assert((select count(*) = 1 from hrms.audit_logs where action = 'device_user.link' and created_at = now()), 'link is audited');

-- ---------------------------------------------------------------------- photos
select pg_temp.as_service();
create temp table r7 as select
  -- Photo for a punch that has not arrived yet (pin 2, 5 minutes ago).
  public.internal_attach_device_photo(:secret, 'SIMESSL0001', null, 'ip', '2', pg_temp.lt(300),
    '00000000-0000-4000-8000-000000000001/SIMESSL0001/' || to_char((now() at time zone 'Asia/Kolkata') - interval '300 seconds', 'YYYY-MM-DD')
      || '/2-' || to_char((now() at time zone 'Asia/Kolkata') - interval '300 seconds', 'HH24MISS') || '-aaaaaaaa.jpg',
    repeat('a', 64), 1234) as early,
  public.internal_attach_device_photo(:secret, 'SIMESSL0001', null, 'ip', '2', pg_temp.lt(300),
    'elsewhere/evil.jpg', repeat('a', 64), 1234) as bad_path;
create temp table r8 as select public.internal_ingest_device_punches(:secret, 'SIMESSL0001', null, 'ip',
  jsonb_build_array(jsonb_build_object('line', 1, 'pin', '2', 'device_time', pg_temp.lt(300), 'status', '0', 'verify', '15')), null) as res;
reset role;
select pg_temp.assert((select (early->>'ok')::boolean and early->'punch_id' = 'null'::jsonb and bad_path->>'code' = 'bad_photo_path' from r7),
  'photo before its punch is stored; a path outside the device prefix is refused');
select pg_temp.assert((select photo_path like '%/2-%-aaaaaaaa.jpg' from hrms.device_punch_events where pin = '2'),
  'photo attaches when the punch arrives');

select id as photo_punch from hrms.device_punch_events where pin = '2' \gset
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert((select public.authorize_device_photo(:'photo_punch')->'data'->>'bucket' = 'device-photos'),
  'HR is authorised to view the photo');
reset role;
select pg_temp.as_user(:member::uuid);
select pg_temp.assert(pg_temp.err(format('select public.authorize_device_photo(%L)', :'photo_punch')) = 'ACCESS_DENIED',
  'a member cannot view punch photos');
reset role;
select pg_temp.assert((select count(*) = 1 from hrms.audit_logs where action = 'device_photo.view' and created_at = now()), 'photo view is audited');

-- ----------------------------------------------------- device management
update hrms.employees set auth_user_id = '10000000-0000-4000-8000-000000000001' where employee_code = 'DEMO-001'; -- admin
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert(pg_temp.err($$select public.save_attendance_device('{"serial":"NEWDEV0001","label":"Back door"}')$$) = 'ACCESS_DENIED',
  'HR cannot register devices (Admin only)');
reset role;
select pg_temp.as_user('10000000-0000-4000-8000-000000000001'::uuid);
create temp table r9 as select public.save_attendance_device('{"serial":"newdev0001","label":"Back door","mode":"http","token":"sixteen-chars-token!"}') as res;
select pg_temp.assert(pg_temp.err($$select public.save_attendance_device('{"serial":"NEWDEV0001","label":"Dup"}')$$) = 'VALIDATION_FAILED',
  'a serial can only be registered once');
select pg_temp.assert(pg_temp.err(format($$select public.save_attendance_device('{"id":"%s","serial":"OTHER0001","label":"x"}')$$,
                       (select res->'data'->>'id' from r9))) = 'VALIDATION_FAILED',
  'a serial cannot be changed after registration');
reset role;
select pg_temp.assert((select token_sha256 = hrms.sha256_hex('sixteen-chars-token!') and serial = 'NEWDEV0001'
                       from hrms.attendance_devices where serial = 'NEWDEV0001'),
  'Admin registered a device; serial upper-cased; token stored only as a hash');
select pg_temp.assert((select count(*) = 1 from hrms.audit_logs where action = 'device.register' and classification = 'security' and created_at = now()
                       and not (changes ? 'token')), 'registration audited without the token');

-- ----------------------------------------------------- machine user roster
select pg_temp.as_service();
create temp table r10 as select public.internal_ingest_device_users(:secret, 'SIMESSL0001', null, 'ip',
  '[{"pin":"7","name":"PRIYA","privilege":"0"},{"pin":"1","name":"ASHA","privilege":"14"},{"pin":"x;y","name":"bad"}]', '77') as res;
reset role;
select pg_temp.assert((select res->>'stored' = '2' and res->>'invalid' = '1' from r10), 'roster stored valid PINs only');
select pg_temp.assert((select is_device_admin from hrms.device_users where pin = '1') and
                      (select oplog_stamp = 77 from hrms.attendance_devices where serial = 'SIMESSL0001'),
  'machine admin flag and oplog cursor recorded');
select pg_temp.assert(not exists (select 1 from information_schema.columns where table_schema = 'hrms' and table_name = 'device_users'
                                  and column_name ~ 'pass|card|template|tmp|finger|face'),
  'roster table has no column for passwords, cards or biometrics');

-- ------------------------------------------- access comes from HRMS roles
-- Manager is only a label: it grants nothing on the device dashboard.
update hrms.employees set auth_user_id = '10000000-0000-4000-8000-000000000003', auth_alias = 'u-10000000-0000-4000-8000-000000000003@test.invalid'
 where id = '00000000-0000-4000-8000-0000000000e3';
insert into iam.users (id, email) values ('10000000-0000-4000-8000-000000000003', 'u-10000000-0000-4000-8000-000000000003@test.invalid');
insert into iam.sessions (id, user_id, created_at) values ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', now() - interval '1 hour');
select pg_temp.as_user('10000000-0000-4000-8000-000000000003'::uuid);
select pg_temp.assert(pg_temp.err($$select public.list_attendance_devices()$$) = 'ACCESS_DENIED',
  'a Manager label gives no access to devices');
reset role;
-- Revoking HR removes access on the next call (no cached role).
update hrms.role_grants set revoked_at = now() where employee_id = '00000000-0000-4000-8000-0000000000e2' and role = 'hr';
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert(pg_temp.err($$select public.list_attendance_devices()$$) = 'ACCESS_DENIED',
  'revoked HR loses device access immediately');
reset role;
update hrms.role_grants set revoked_at = null where employee_id = '00000000-0000-4000-8000-0000000000e2' and role = 'hr';
-- A session created before the credential barrier is refused (password reset).
update hrms.employees set credentials_valid_after = now() where id = '00000000-0000-4000-8000-0000000000e2';
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert(pg_temp.err($$select public.list_attendance_devices()$$) = 'AUTH_REQUIRED',
  'a session from before a password reset cannot read devices');
reset role;
-- A deleted (revoked) session is refused.
update hrms.employees set credentials_valid_after = now() - interval '1 day' where id = '00000000-0000-4000-8000-0000000000e2';
delete from iam.sessions where id = :hr::uuid;
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert(pg_temp.err($$select public.list_attendance_devices()$$) = 'AUTH_REQUIRED',
  'a signed-out session cannot read devices');
reset role;

\echo 'ALL DEVICE ATTENDANCE TESTS PASSED'
rollback;
