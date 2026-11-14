-- web-hrms live events (20261113100100_web_live_events.sql, 20261114110000_web_device_day_live.sql):
-- every producer publishes to hrms.live_events with the right audience, ids-only payloads.
begin;
select test.standard_org();
select test.as_admin_db();
select public.internal_configure_device_ingest(repeat('s', 40));
insert into hrms.attendance_devices (org_id, serial, label)
values ((select id from hrms.organizations where code = 'TEST_ORG'), 'LIVE0001', 'Door');
insert into hrms.device_user_links (org_id, serial, pin, employee_id)
values ((select id from hrms.organizations where code = 'TEST_ORG'), null, '4242', test.emp('EMP01'));
create temp table mark as select coalesce(max(id), 0) as id from hrms.live_events;
grant select on mark to public;

select test.ok((public.internal_ingest_device_punches(repeat('s', 40), 'LIVE0001', null, 'h',
  jsonb_build_array(jsonb_build_object('line', 1, 'pin', '4242',
    'device_time', to_char(now() at time zone 'Asia/Kolkata' - interval '5 minutes', 'YYYY-MM-DD HH24:MI:SS'),
    'status', '0', 'verify', '1'))) ->> 'accepted')::int = 1, 'LIVE-001 a matched machine punch is ingested');

select test.ok(exists (select 1 from hrms.live_events e, mark m where e.id > m.id and e.kind = 'device.punch'
  and e.audience = 'hr_admin' and e.employee_id is null and e.payload ? 'id'), 'LIVE-002 device.punch goes to HR/Admin');
select test.ok(exists (select 1 from hrms.live_events e, mark m where e.id > m.id and e.kind = 'device.day'
  and e.audience = 'hr_admin' and e.payload ->> 'employee_id' = test.emp('EMP01')::text), 'LIVE-003 device.day goes to HR/Admin');
select test.ok(not exists (select 1 from hrms.live_events e, mark m where e.id > m.id
  and (e.payload::text like '%4242%' or e.payload ? 'name')), 'LIVE-004 payloads carry ids only (no PIN, no names)');
select test.ok((select bool_and(e.org_id = (select id from hrms.organizations where code = 'TEST_ORG'))
  from hrms.live_events e, mark m where e.id > m.id), 'LIVE-005 events are scoped to the organisation');

-- commands
truncate mark; insert into mark select coalesce(max(id), 0) from hrms.live_events;
insert into hrms.device_commands (org_id, serial, kind, pin, reason)
values ((select id from hrms.organizations where code = 'TEST_ORG'), 'LIVE0001', 'user_delete', '77', 'sync');
select test.ok(exists (select 1 from hrms.live_events e, mark m where e.id > m.id and e.kind = 'device.command'
  and e.audience = 'hr_admin' and e.payload ->> 'status' = 'queued'), 'LIVE-006 a queued command is announced');
update hrms.device_commands set status = 'done' where serial = 'LIVE0001' and pin = '77';
select test.ok(exists (select 1 from hrms.live_events e, mark m where e.id > m.id and e.kind = 'device.command'
  and e.payload ->> 'status' = 'done'), 'LIVE-007 ...and its result');

-- notifications go to the one recipient
truncate mark; insert into mark select coalesce(max(id), 0) from hrms.live_events;
insert into hrms.notifications (org_id, recipient_id, event_id, kind, title)
values ((select id from hrms.organizations where code = 'TEST_ORG'), test.emp('EMP02'), gen_random_uuid(), 'test', 'Hello');
select test.ok(exists (select 1 from hrms.live_events e, mark m where e.id > m.id and e.kind = 'notification.new'
  and e.audience = 'employee' and e.employee_id = test.emp('EMP02')), 'LIVE-008 a notification wakes only its recipient');

-- shape rules
select test.throws($$insert into hrms.live_events (org_id, audience, kind) values
  ((select id from hrms.organizations where code = 'TEST_ORG'), 'employee', 'x.y')$$, '23514',
  'LIVE-009 an employee event needs its employee');
select test.throws($$insert into hrms.live_events (org_id, audience, kind) values
  ((select id from hrms.organizations where code = 'TEST_ORG'), 'world', 'x.y')$$, '23514', 'LIVE-010 unknown audiences are refused');
select test.throws($$insert into hrms.live_events (org_id, audience, kind, payload) values
  ((select id from hrms.organizations where code = 'TEST_ORG'), 'org', 'x.y', jsonb_build_object('a', repeat('x', 2000)))$$,
  '23514', 'LIVE-011 payloads stay small');
select test.throws($$insert into hrms.live_events (org_id, audience, kind) values
  ((select id from hrms.organizations where code = 'TEST_ORG'), 'org', 'Bad Kind')$$, '23514', 'LIVE-012 kinds are checked');

-- a broken publisher never fails the producing write
create or replace function hrms.publish_live(p_org uuid, p_audience text, p_employee uuid, p_kind text, p_payload jsonb) returns void
language plpgsql as $$ begin raise exception 'boom'; end $$;
insert into hrms.notifications (org_id, recipient_id, event_id, kind, title)
values ((select id from hrms.organizations where code = 'TEST_ORG'), test.emp('EMP03'), gen_random_uuid(), 'test', 'Still saved');
select test.ok(exists (select 1 from hrms.notifications where title = 'Still saved'), 'LIVE-013 producers survive a live failure');

-- access: only the server reads or purges
select test.ok(not has_table_privilege('authenticated', 'hrms.live_events', 'select'), 'LIVE-014 browsers cannot read the event table');
select test.ok(not has_function_privilege('authenticated', 'public.internal_purge_live_events(interval)', 'execute'),
  'LIVE-015 ...or purge it');
update hrms.live_events set created_at = now() - interval '3 hours' where id = (select min(id) from hrms.live_events);
select test.ok(public.internal_purge_live_events() >= 1, 'LIVE-016 purge removes events older than two hours');
select test.ok(exists (select 1 from hrms.live_events where kind = 'notification.new'), 'LIVE-017 ...and keeps recent ones for reconnects');
rollback;
