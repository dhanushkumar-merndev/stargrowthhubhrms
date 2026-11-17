-- Machine punches drive lateness, hours worked and the salary estimate.
-- Fixed past month (October 2026, starts on a Thursday) so the result never
-- depends on today. Runs after _prelude.sql (pnpm db:test).

\set org '''00000000-0000-4000-8000-000000000001'''
\set asha '''00000000-0000-4000-8000-0000000000e1'''
\set vikram '''00000000-0000-4000-8000-0000000000e2'''

set local session_replication_role = replica;
-- General 10:00-19:00, 30 min grace, Mon-Fri; Intern 14:00-19:00, 30 min grace.
insert into hrms.shifts (id, org_id, name) values
  ('00000000-0000-4000-8000-00000000f001', :org, 'General (test)'),
  ('00000000-0000-4000-8000-00000000f002', :org, 'Intern (test)');
insert into hrms.shift_versions (org_id, shift_id, version_no, effective_from, start_local, end_local, weekly_mask,
                                 grace_seconds, state, published_at) values
  (:org, '00000000-0000-4000-8000-00000000f001', 1, '2026-09-01', '10:00', '19:00', 31, 1800, 'published', now()),
  (:org, '00000000-0000-4000-8000-00000000f002', 1, '2026-09-01', '14:00', '19:00', 31, 1800, 'published', now());
delete from hrms.shift_assignments where employee_id in (:asha, :vikram);
insert into hrms.shift_assignments (org_id, employee_id, shift_id, effective_from) values
  (:org, :asha, '00000000-0000-4000-8000-00000000f001', '2026-09-01'),
  (:org, :vikram, '00000000-0000-4000-8000-00000000f002', '2026-09-01');
insert into hrms.salary_profiles (org_id, employee_id, monthly_salary) values (:org, :asha, 31000)
on conflict (employee_id) do update set monthly_salary = excluded.monthly_salary;

create function pg_temp.ist(p_day text, p_time text) returns timestamptz language sql as $$
  select (p_day::date + p_time::time) at time zone 'Asia/Kolkata';
$$;
-- Asha: on time (10:20, 10:30 sharp), then late 4 times (10:31, 10:45, 11:00, 12:00); one open day.
insert into hrms.device_attendance_days (org_id, employee_id, local_date, first_in_at, out_at, out_source, scan_count)
select :org, :asha, d::date, pg_temp.ist(d, t_in), pg_temp.ist(d, '19:00'), 'device', 2
from (values ('2026-10-01', '10:20'), ('2026-10-02', '10:30'), ('2026-10-05', '10:31'),
             ('2026-10-06', '10:45'), ('2026-10-07', '11:00'), ('2026-10-08', '12:00')) v(d, t_in);
-- Vikram (intern): 14:25 on time, 14:40 late.
insert into hrms.device_attendance_days (org_id, employee_id, local_date, first_in_at, out_at, out_source, scan_count)
select :org, :vikram, d::date, pg_temp.ist(d, t_in), pg_temp.ist(d, '19:00'), 'device', 2
from (values ('2026-10-01', '14:25'), ('2026-10-02', '14:40')) v(d, t_in);
set local session_replication_role = origin;

select hrms.ensure_schedule_instances(:org, array[:asha, :vikram]::uuid[], '2026-10-01', '2026-10-31');

create function pg_temp.r(p_emp uuid, p_day text) returns hrms.attendance_row language sql as $$
  select r.* from hrms.attendance_rows('00000000-0000-4000-8000-000000000001', array[p_emp], p_day::date, p_day::date, now()) r;
$$;

-- ------------------------------------------------------------- day rows
select pg_temp.assert((pg_temp.r(:asha, '2026-10-01')).effective_source = 'device', 'a machine punch is the day''s source');
select pg_temp.assert((pg_temp.r(:asha, '2026-10-01')).status = 'present', 'IN and OUT on the machine = present');
select pg_temp.assert(not ((pg_temp.r(:asha, '2026-10-01')).calc).is_late, '10:20 on a 10:00 shift is not late');
select pg_temp.assert(not ((pg_temp.r(:asha, '2026-10-02')).calc).is_late, '10:30 exactly is still within the grace');
select pg_temp.assert(((pg_temp.r(:asha, '2026-10-05')).calc).is_late, '10:31 is late');
select pg_temp.assert(((pg_temp.r(:asha, '2026-10-06')).calc).late_seconds = 45 * 60, 'late by 45 minutes at 10:45');
select pg_temp.assert(((pg_temp.r(:asha, '2026-10-01')).calc).presence_seconds = (8 * 60 + 40) * 60,
  '10:20-19:00 = 8 h 40 m worked');
select pg_temp.assert((pg_temp.r(:asha, '2026-10-09')).status = 'absent', 'a past workday with no punch is absent');
select pg_temp.assert(not ((pg_temp.r(:vikram, '2026-10-01')).calc).is_late, 'intern 14:25 on a 14:00 shift is not late');
select pg_temp.assert(((pg_temp.r(:vikram, '2026-10-02')).calc).is_late, 'intern 14:40 is late');

-- ------------------------------------------------------------- month
create function pg_temp.m(p_emp uuid) returns jsonb language sql as $$
  select d.summary from hrms.month_deductions('00000000-0000-4000-8000-000000000001', array[p_emp], '2026-10-01', now()) d;
$$;
select pg_temp.assert((pg_temp.m(:asha) ->> 'worked_days')::int = 6, '6 days worked');
select pg_temp.assert((pg_temp.m(:asha) ->> 'late_days')::int = 4, '4 late days');
select pg_temp.assert((pg_temp.m(:asha) ->> 'late_penalty_days')::int = 1, '4 lates = 1 day cut');
select pg_temp.assert((pg_temp.m(:asha) ->> 'workdays_so_far')::int = 22, 'October 2026 has 22 Mon-Fri workdays');
select pg_temp.assert((pg_temp.m(:asha) ->> 'unpaid_without_permission_days')::numeric = 16, 'the 16 unpunched workdays are absent');
select pg_temp.assert((pg_temp.m(:asha) ->> 'cut_days')::numeric = 17, 'cut = 1 late day + 16 absent');
select pg_temp.assert((pg_temp.m(:asha) ->> 'estimated_deduction')::numeric = 17000, '31000 / 31 x 17 = 17000');
select pg_temp.assert((pg_temp.m(:asha) ->> 'estimated_pay')::numeric = 14000, 'estimated pay = 31000 - 17000');
select pg_temp.assert((pg_temp.m(:asha) ->> 'worked_seconds')::int =
  ((8*60+40) + (8*60+30) + (8*60+29) + (8*60+15) + 8*60 + 7*60) * 60, 'hours worked add up');
select pg_temp.assert((pg_temp.m(:vikram) ->> 'late_days')::int = 1 and (pg_temp.m(:vikram) ->> 'late_penalty_days')::int = 0,
  'intern: 1 late, no cut yet');

-- An excused late day no longer counts.
insert into hrms.late_excuses (org_id, employee_id, shift_date, approved_by) values (:org, :asha, '2026-10-08', :vikram);
select pg_temp.assert((pg_temp.m(:asha) ->> 'late_days')::int = 3 and (pg_temp.m(:asha) ->> 'late_penalty_days')::int = 0,
  'an approved late arrival request removes the cut');

-- Every day appears once.
select pg_temp.assert((select count(*) from hrms.attendance_rows(:org, array[:asha]::uuid[], '2026-10-01', '2026-10-31', now())) = 31,
  'one row per day, machine days not duplicated');

\echo 'ALL MACHINE ATTENDANCE TESTS PASSED'
rollback;
