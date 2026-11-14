-- [web-hrms] Ported from ~/Documents/Projects/September/HRMS/hrms/supabase/tests/database/19_punch_notifications.sql
-- [web-hrms]   unchanged

-- PNOTIF-001..008: every successful check-in / check-out notifies all active
-- HR and Admin users (inbox + push outbox), never the punching employee.
begin;
select test.standard_org();

create or replace function pg_temp.o1() returns uuid language sql security definer as
$$ select id from hrms.offices where name = 'O1' and org_id = test.org('TEST_ORG') $$;

create or replace function pg_temp.at(p_m double precision, p_az double precision default 0.785398)
returns table (lat double precision, lng double precision) language sql as $$
  select extensions.st_y(g::extensions.geometry), extensions.st_x(g::extensions.geometry)
  from (select extensions.st_project(location, p_m, p_az) as g from hrms.offices where id = pg_temp.o1()) s;
$$;

create or replace function pg_temp.device(p_code text) returns uuid language sql as $$
  insert into hrms.devices (org_id, employee_id, installation_id, platform, public_key_spki, attestation_level,
                            biometric_bound)
  values (test.org('TEST_ORG'), test.emp(p_code), gen_random_uuid(), 'android', repeat('A', 91), 'hardware', true)
  returning id;
$$;

create or replace function pg_temp.instance(p_code text, p_day date, p_start_offset interval default '-1 hour',
                                            p_len interval default '9 hours') returns uuid language sql as $$
  insert into hrms.work_schedule_instances (org_id, employee_id, shift_date, kind, is_required, office_id,
    shift_version_id, timezone, start_at, end_at, lunch_paid, grace_seconds, early_entry_seconds, early_credit,
    checkout_extension_seconds, expected_seconds, half_split_at)
  select test.org('TEST_ORG'), test.emp(p_code), p_day, 'workday', true, pg_temp.o1(), sv.id, 'Asia/Kolkata',
         now() + p_start_offset, now() + p_start_offset + p_len, true, 600, 1800, false, 7200,
         extract(epoch from p_len)::integer, now() + p_start_offset + p_len / 2
  from hrms.shift_versions sv join hrms.shifts s on s.id = sv.shift_id and s.name = 'General'
  returning id;
$$;

create or replace function pg_temp.punch(p_code text, p_action text, p_target uuid, p_device uuid,
  p_key uuid default null, p_dist double precision default 5) returns jsonb language plpgsql as $$
declare p test.people; v_key uuid := coalesce(p_key, gen_random_uuid()); v_receipt timestamptz := clock_timestamp();
  v_ch uuid;
begin
  select * into p from test.people where code = p_code;
  insert into hrms.punch_challenges (org_id, employee_id, device_id, action, target_id, nonce, expires_at)
  values (test.org('TEST_ORG'), test.emp(p_code), p_device, p_action, p_target, hrms.random_token(),
          clock_timestamp() + interval '60 seconds')
  returning id into v_ch;
  return public.internal_commit_punch(p.auth_user_id, p.session_id, p.alias, v_key, 'hash-' || v_key::text,
    v_ch, p_action, p_target, p_device, pg_temp.o1(), (pg_temp.at(p_dist)).lat, (pg_temp.at(p_dist)).lng, 5,
    v_receipt - interval '2 seconds', v_receipt, '{"level":"hardware","mock_location":false}');
end $$;

create or replace function pg_temp.recipients(p_kind text) returns text[] language sql security definer as $$
  select coalesce(array_agg(p.code order by p.code), '{}')
  from hrms.notifications n join test.people p on p.employee_id = n.recipient_id
  where n.kind = p_kind;
$$;

-- ============================================================ duration copy
select test.eq(hrms.fmt_minutes(30), 'under 1 min', 'PNOTIF-001 under a minute');
select test.eq(hrms.fmt_minutes(12 * 60 + 5), '12 min', 'PNOTIF-001 minutes');
select test.eq(hrms.fmt_minutes(3600), '1 h', 'PNOTIF-001 whole hour');
select test.eq(hrms.fmt_minutes(3600 + 5 * 60), '1 h 5 min', 'PNOTIF-001 hours and minutes');

-- ============================================================ check-in (late)
select test.as_admin_db();
create temporary table t as select pg_temp.device('EMP01') as dev, pg_temp.instance('EMP01', date '2030-02-01') as inst;
create temporary table k as select gen_random_uuid() as key;
create temporary table p1 as select pg_temp.punch('EMP01', 'IN', inst, dev, (select key from k)) as res from t;
select test.eq((select (res ->> 'ok')::boolean from p1), true, 'PNOTIF-002 check-in accepted');
select test.eq(pg_temp.recipients('attendance.punch_in'), array['ADMIN01', 'HR01', 'HR02'],
  'PNOTIF-002 all HR and Admin notified; employee, managers and other staff are not');
select test.eq((select count(*)::integer from hrms.outbox o join hrms.notifications n on n.id = o.notification_id
                where n.kind = 'attendance.punch_in' and o.status = 'pending'), 3, 'PNOTIF-002 one push job per recipient');
select test.eq((select distinct title from hrms.notifications where kind = 'attendance.punch_in'),
  'Employee E1 checked in', 'PNOTIF-003 title names the employee');
select test.ok((select bool_and(body ~ '^In at \d{1,2}:\d{2} (AM|PM) · Late by ')
                from hrms.notifications where kind = 'attendance.punch_in'), 'PNOTIF-003 body: local time and lateness');
select test.ok((select bool_and(body !~ '(\d+\.\d+|metre|distance)')
                from hrms.notifications where kind = 'attendance.punch_in'), 'PNOTIF-003 no location details in copy');
select test.eq((select distinct deep_link from hrms.notifications where kind = 'attendance.punch_in'),
  '/reports/hours?employee=' || test.emp('EMP01'), 'PNOTIF-003 opens the employee''s attendance');

-- Replaying the same operation returns the stored result without new alerts.
select pg_temp.punch('EMP01', 'IN', inst, dev, (select key from k)) from t;
select test.eq((select count(*)::integer from hrms.notifications where kind = 'attendance.punch_in'), 3,
  'PNOTIF-004 idempotent replay does not notify again');

-- ============================================================ check-out (early)
create temporary table p2 as select pg_temp.punch('EMP01', 'OUT',
  (select id from hrms.attendance_sessions where employee_id = test.emp('EMP01') and state = 'open'), dev) as res from t;
select test.eq((select (res ->> 'ok')::boolean from p2), true, 'PNOTIF-005 check-out accepted');
select test.eq(pg_temp.recipients('attendance.punch_out'), array['ADMIN01', 'HR01', 'HR02'],
  'PNOTIF-005 check-out notifies HR and Admin');
select test.eq((select distinct title from hrms.notifications where kind = 'attendance.punch_out'),
  'Employee E1 checked out', 'PNOTIF-005 check-out title');
select test.ok((select bool_and(body ~ '^Out at .* · Left early by ')
                from hrms.notifications where kind = 'attendance.punch_out'), 'PNOTIF-005 early departure shown');

-- ============================================================ on time, HR punching
delete from hrms.outbox; delete from hrms.notifications;
create temporary table t2 as select pg_temp.device('HR01') as dev,
  pg_temp.instance('HR01', date '2030-02-02', '10 minutes') as inst;
select pg_temp.punch('HR01', 'IN', inst, dev) from t2;
select test.eq(pg_temp.recipients('attendance.punch_in'), array['ADMIN01', 'HR02'],
  'PNOTIF-006 HR is not notified about their own punch');
select test.ok((select bool_and(body ~ ' · On time$') from hrms.notifications where kind = 'attendance.punch_in'),
  'PNOTIF-006 on-time check-in');

-- ============================================================ rejected / inactive
delete from hrms.outbox; delete from hrms.notifications;
update hrms.employees set status = 'inactive' where id = test.emp('HR02');
create temporary table t3 as select pg_temp.device('EMP02') as dev, pg_temp.instance('EMP02', date '2030-02-03') as inst;
select test.eq((select test.err(pg_temp.punch('EMP02', 'IN', inst, dev, null, 500)) from t3), 'OUTSIDE_ZONE',
  'PNOTIF-007 punch outside the office is rejected');
select test.eq((select count(*)::integer from hrms.notifications), 0, 'PNOTIF-007 rejected punch sends nothing');
select pg_temp.punch('EMP02', 'IN', inst, dev) from t3;
select test.eq(pg_temp.recipients('attendance.punch_in'), array['ADMIN01', 'HR01'],
  'PNOTIF-008 inactive HR is not notified');

rollback;
