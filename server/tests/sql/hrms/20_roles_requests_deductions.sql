-- [web-hrms] Ported from ~/Documents/Projects/September/HRMS/hrms/supabase/tests/database/20_roles_requests_deductions.sql
-- [web-hrms]   fixture patch: session re-created after deactivation

-- RBAC3-001..012, WFH-001..008, LATEREQ-001..005, DED-001..010, MED-001..003:
-- three roles, work-from-home and late arrival requests reviewed by the HR/Admin
-- pool, monthly deductions and medical certificate expiry.
begin;
select test.standard_org();
create or replace function pg_temp.ver(p_code text) returns integer language sql security definer as
$$ select version from hrms.employees where id = test.emp(p_code) $$;

-- ============================================================ three roles
select test.ok('payroll.manage' = any(hrms.role_bundle('hr')) and 'documents.medical' = any(hrms.role_bundle('hr')),
  'RBAC3-001 HR holds payroll and medical access by role');
select test.eq(hrms.role_bundle('manager'), array[]::text[], 'RBAC3-001 Manager grants nothing');
select test.eq((select position_label from hrms.employees where id = test.emp('MGR01')), 'manager',
  'RBAC3-002 Manager is a label');
select test.throws(format($q$insert into hrms.role_grants (org_id, employee_id, role) values (%L, %L, 'manager')$q$,
  test.org('TEST_ORG'), test.emp('EMP03')), '23514', 'RBAC3-002 new Manager role grants are rejected');
select test.throws(format($q$insert into hrms.permission_grants (org_id, employee_id, permission) values (%L, %L, 'payroll.manage')$q$,
  test.org('TEST_ORG'), test.emp('EMP03')), '23514', 'RBAC3-002 extra permission grants are retired');

select test.login('HR01');
select test.eq(public.get_session_context() -> 'data' ->> 'role', 'hr', 'RBAC3-003 session exposes the single role');
select test.throws(format($q$select public.set_employee_access(%L, 'hr', null, 'Promote')$q$, test.emp('EMP01')),
  'REAUTH_REQUIRED', 'RBAC3-004 HR promoting to HR needs a password confirmation');
select test.throws(format($q$select public.set_employee_access(%L, 'admin', null, 'Promote')$q$, test.emp('EMP02')),
  'ACCESS_DENIED', 'RBAC3-005 HR cannot create an Admin');
select test.throws(format($q$select public.set_employee_access(%L, 'employee', null, 'Demote')$q$, test.emp('ADMIN01')),
  'ACCESS_DENIED', 'RBAC3-005 HR cannot change an Admin');
select test.throws(format($q$select public.set_employee_access(%L, 'employee', null, 'Self')$q$, test.emp('HR01')),
  'ACCESS_DENIED', 'RBAC3-006 nobody changes their own role');
select test.as_admin_db();
select public.internal_issue_reauth_grant((select auth_user_id from test.people where code = 'HR01'),
  (select session_id from test.people where code = 'HR01'), (select alias from test.people where code = 'HR01'),
  'role.elevate', null);
select test.login('HR01');
select test.eq(public.set_employee_access(test.emp('EMP01'), 'hr', null, 'Joins HR') -> 'data' ->> 'role', 'hr',
  'RBAC3-004 HR promotes an Employee to HR');
select test.eq(public.set_employee_access(test.emp('EMP02'), 'employee', 'manager', 'Leads the floor')
  -> 'data' ->> 'position_label', 'manager', 'RBAC3-007 label changes without reauth');
select test.eq(public.set_employee_access(test.emp('EMP01'), 'employee', null, 'Back to team') -> 'data' ->> 'role',
  'employee', 'RBAC3-008 demotion needs no reauth');
select test.as_admin_db();
select test.eq((select count(*)::integer from hrms.notifications where recipient_id = test.emp('EMP01')
                and kind = 'access.role_changed'), 2, 'RBAC3-008 employee told about each role change');
select test.login('HR01');

-- Remove from organisation: HR may remove HR, never an Admin.
select test.throws(format($q$select public.set_employee_status(%L, 'inactive', null, 'Left', %s)$q$, test.emp('ADMIN01'),
  pg_temp.ver('ADMIN01')), 'ACCESS_DENIED',
  'RBAC3-009 HR cannot remove an Admin');
select test.eq(public.set_employee_status(test.emp('HR02'), 'inactive', null, 'Left the company',
  pg_temp.ver('HR02')) -> 'data' ->> 'status', 'inactive',
  'RBAC3-009 HR removes another HR (history kept)');
select test.as_admin_db();
update hrms.employees set status = 'active', end_date = null, credentials_valid_after = now() - interval '1 day'
where id = test.emp('HR02');
-- [web-hrms] deactivation now signs the person out everywhere (sessions are
-- deleted); re-create HR02's fixture session for the rest of the suite.
insert into iam.sessions (id, user_id) select session_id, auth_user_id from test.people
 where code = 'HR02' on conflict (id) do nothing;

-- Provisioning.
create or replace function pg_temp.fields(p_code text, p_role text default null) returns jsonb language sql security definer as $$
  select jsonb_build_object('employee_code', p_code, 'full_name', 'New ' || p_code, 'join_date', current_date,
    'team_id', (select id from hrms.teams where name = 'Team1'), 'office_id', (select id from hrms.offices where name = 'O1'),
    'shift_id', (select id from hrms.shifts where name = 'General'), 'role', p_role);
$$;
create temporary table hr_ids as select auth_user_id, session_id, alias from test.people where code = 'HR01';
select test.throws(format($f$select public.internal_provision_begin(%L, %L, %L, gen_random_uuid(), pg_temp.fields('NEWADM', 'admin'), 'x')$f$,
  (select auth_user_id from hr_ids), (select session_id from hr_ids), (select alias from hr_ids)), 'ACCESS_DENIED',
  'RBAC3-010 HR cannot create Admin accounts');
select public.internal_provision_begin((select auth_user_id from hr_ids), (select session_id from hr_ids),
  (select alias from hr_ids), gen_random_uuid(), pg_temp.fields('NEWHR', 'hr'), 'x');
select test.eq(hrms.employee_roles((select id from hrms.employees where employee_code = 'NEWHR')), array['hr'],
  'RBAC3-010 HR creates HR accounts');
select public.internal_provision_begin((select auth_user_id from hr_ids), (select session_id from hr_ids),
  (select alias from hr_ids), gen_random_uuid(), pg_temp.fields('NEWMGR', 'manager'), 'x');
select test.ok((select position_label = 'manager' and hrms.employee_roles(id) = array[]::text[]
                from hrms.employees where employee_code = 'NEWMGR'), 'RBAC3-011 "manager" in an import becomes the label');

select test.login('MGR01');
select test.throws($$select public.list_access_grants()$$, 'ACCESS_DENIED', 'RBAC3-012 Employees cannot manage access');

-- ============================================================ work from home
-- Monday of the week after next: always a future working week.
create or replace function pg_temp.mon() returns date language sql as $$
  select current_date + ((7 - extract(isodow from current_date)::integer) + 1) + 7;
$$;
select test.login('EMP03');
create temporary table w1 as select public.save_attendance_request('wfh', null, pg_temp.mon(), pg_temp.mon() + 4,
  'Plumber visit at home', true, null, gen_random_uuid()) as res;
select test.eq((select res -> 'data' ->> 'state' from w1), 'submitted', 'WFH-001 request submitted');
select test.eq((select (res -> 'data' ->> 'units')::integer from w1), 5, 'WFH-001 five working days');
select test.as_admin_db();
select test.eq((select array_agg(p.code order by p.code) from hrms.notifications n join test.people p on p.employee_id = n.recipient_id
                where n.kind = 'request.submitted' and n.data ->> 'request_id' = (select res -> 'data' ->> 'id' from w1)),
  array['ADMIN01', 'HR01', 'HR02'], 'WFH-002 every HR and Admin is notified');
select test.ok((select bool_and(body like 'Employee E3 asked to work from home%') from hrms.notifications
                where kind = 'request.submitted' and data ->> 'request_id' = (select res -> 'data' ->> 'id' from w1)),
  'WFH-002 notification names the employee, not the reason');
select test.login('EMP03');
select test.throws(format($q$select public.save_attendance_request('wfh', null, %L, %L, 'Again', true, null, gen_random_uuid())$q$,
  pg_temp.mon() + 2, pg_temp.mon() + 2), 'VALIDATION_FAILED', 'WFH-003 overlapping request rejected');

select test.login('MGR01');
select test.throws(format('select public.open_request_for_review(%L)', (select res -> 'data' ->> 'id' from w1)),
  'ACCESS_DENIED', 'WFH-004 a Manager-labelled employee cannot review');
select test.login('HR02');  -- not the default reviewer: anyone in the pool can decide
create temporary table w2 as select public.open_request_for_review((res -> 'data' ->> 'id')::uuid) as res from w1;
select test.eq((select res -> 'data' ->> 'authority' from w2), 'pool', 'WFH-005 pool authority');
select test.eq(jsonb_array_length(public.list_review_queue() -> 'data'), 1, 'WFH-005 shows in every HR queue');
create temporary table w3 as select public.decide_request((res -> 'data' ->> 'id')::uuid, 'approve', null,
  (res ->> 'version')::integer) as res from w2;
select test.eq((select res -> 'data' ->> 'state' from w3), 'approved', 'WFH-005 approved without an override reason');
select test.as_admin_db();
select test.eq((select count(*)::integer from hrms.outside_work where employee_id = test.emp('EMP03')
                and kind = 'wfh' and request_id is not null and revoked_at is null), 5,
  'WFH-006 approval marks the days as work from home');
select test.eq((select r.effective_source
                from hrms.attendance_rows(test.org('TEST_ORG'), array[test.emp('EMP03')], pg_temp.mon(), pg_temp.mon(), now()) r),
  'wfh', 'WFH-006 attendance source is wfh, not outside work');
select test.eq((select hrms.attendance_row_json(r) ->> 'outside_reason'
                from hrms.attendance_rows(test.org('TEST_ORG'), array[test.emp('EMP03')], pg_temp.mon(), pg_temp.mon(), now()) r),
  'Plumber visit at home', 'WFH-006 attendance day keeps the employee''s reason');
select test.eq((select title from hrms.notifications where recipient_id = test.emp('EMP03') and kind = 'request.approved'),
  'Work from home approved', 'WFH-007 employee notified of the decision');

-- WFH-009 Work from home and Outside work stay separate.
select test.login('HR01');
select public.grant_outside_work(array[test.emp('EMP03')], pg_temp.mon() + 7, pg_temp.mon() + 7, 'Client site');
select test.as_admin_db();
select test.eq((select r.effective_source
                from hrms.attendance_rows(test.org('TEST_ORG'), array[test.emp('EMP03')], pg_temp.mon() + 7, pg_temp.mon() + 7, now()) r),
  'outside', 'WFH-009 HR-granted day is outside work');
select test.login('HR01');
select test.eq((select jsonb_agg(distinct x ->> 'kind') from jsonb_array_elements(
                  public.list_outside_work(pg_temp.mon(), 50, null, null, 'wfh') -> 'data') x
                where x -> 'employee' ->> 'id' = test.emp('EMP03')::text), '["wfh"]'::jsonb,
  'WFH-009 list filters work from home');
select test.eq((select count(*)::integer from jsonb_array_elements(
                  public.list_outside_work(pg_temp.mon(), 50, null, null, 'outside') -> 'data') x
                where x -> 'employee' ->> 'id' = test.emp('EMP03')::text), 1,
  'WFH-009 list filters outside work');
select test.as_admin_db();
select test.ok((select s.summary ? 'wfh_days' and s.summary ? 'outside_days'
                from hrms.month_deductions(test.org('TEST_ORG'), array[test.emp('EMP03')], current_date, now()) s),
  'WFH-009 month summary reports wfh_days and outside_days separately');
select test.eq((hrms.attendance_totals((select jsonb_agg(hrms.attendance_row_json(r))
                  from hrms.attendance_rows(test.org('TEST_ORG'), array[test.emp('EMP03')], pg_temp.mon(), pg_temp.mon() + 7, now()) r))
                ->> 'wfh_days')::integer, 5, 'WFH-009 totals count work from home days');
select test.eq((hrms.attendance_totals((select jsonb_agg(hrms.attendance_row_json(r))
                  from hrms.attendance_rows(test.org('TEST_ORG'), array[test.emp('EMP03')], pg_temp.mon(), pg_temp.mon() + 7, now()) r))
                ->> 'outside_days')::integer, 1, 'WFH-009 totals count outside work days separately');
select test.throws(format($q$insert into hrms.outside_work (org_id, employee_id, work_date, reason, granted_by, kind)
                    values (%L, %L, %L, 'x', %L, 'wfh')$q$, test.org('TEST_ORG'), test.emp('EMP03'),
                    pg_temp.mon() + 8, test.emp('HR01')), '23514', 'WFH-009 work from home always comes from a request');
create temporary table wday as select id from hrms.outside_work where employee_id = test.emp('EMP03')
  and kind = 'wfh' and work_date = pg_temp.mon() + 1 and revoked_at is null;
grant select on wday to authenticated;
select test.login('HR01');
select public.revoke_outside_work((select id from wday), 'Needed in office');
select test.as_admin_db();
select test.eq((select title from hrms.notifications where recipient_id = test.emp('EMP03')
                and kind = 'attendance.wfh_revoked'), 'Work from home cancelled',
  'WFH-009 cancelling a WFH day says work from home');
select test.eq((select r.effective_source
                from hrms.attendance_rows(test.org('TEST_ORG'), array[test.emp('EMP03')], pg_temp.mon() + 1, pg_temp.mon() + 1, now()) r),
  null::text, 'WFH-009 cancelled day needs a normal check-in');

select test.login('ADMIN01');
select test.eq(public.save_attendance_request('wfh', null, pg_temp.mon(), pg_temp.mon(), 'Board prep', true, null,
  gen_random_uuid()) -> 'data' ->> 'state', 'approved', 'WFH-008 Admin''s own request applies at once');

-- ============================================================ late arrival request
select test.as_admin_db();
select hrms.ensure_schedule_instances(test.org('TEST_ORG'), array[test.emp('EMP01')], current_date - 14, current_date - 1);
create temporary table lday as select max(shift_date) as d from hrms.work_schedule_instances
  where employee_id = test.emp('EMP01') and shift_date between current_date - 14 and current_date - 1 and is_required;
grant select on lday to authenticated;
select test.login('EMP01');
create temporary table l1 as select public.save_attendance_request('late_excuse', null, (select d from lday), null,
  'Metro was delayed', true, null, gen_random_uuid()) as res;
select test.eq((select res -> 'data' ->> 'state' from l1), 'submitted', 'LATEREQ-001 late arrival request submitted');
select test.throws(format($q$select public.save_attendance_request('late_excuse', null, %L, null, 'x again', true, null, gen_random_uuid())$q$,
  (select d from lday)), 'VALIDATION_FAILED', 'LATEREQ-002 one open request per day');
select test.throws(format($q$select public.save_attendance_request('late_excuse', null, %L, null, 'Too old', true, null, gen_random_uuid())$q$,
  current_date - 60), 'VALIDATION_FAILED', 'LATEREQ-003 only the last 31 days');
select test.login('ADMIN01');
create temporary table l2 as select public.open_request_for_review((res -> 'data' ->> 'id')::uuid) as res from l1;
select public.decide_request((res -> 'data' ->> 'id')::uuid, 'approve', null, (res ->> 'version')::integer) from l2;
select test.as_admin_db();
select test.eq((select count(*)::integer from hrms.late_excuses where employee_id = test.emp('EMP01')
                and shift_date = (select d from lday) and revoked_at is null), 1, 'LATEREQ-004 approval excuses the day');
select test.login('HR01');
select public.revoke_late_excuse(test.emp('EMP01'), (select d from lday), 'Approved by mistake');
select test.as_admin_db();
select test.eq((select count(*)::integer from hrms.late_excuses where employee_id = test.emp('EMP01')
                and shift_date = (select d from lday) and revoked_at is null), 0, 'LATEREQ-005 HR can withdraw an excuse');

-- ============================================================ monthly deductions
-- A closed past month (two months back), all scheduled days materialised.
create or replace function pg_temp.m() returns date language sql as $$
  select (date_trunc('month', current_date) - interval '2 months')::date $$;
select hrms.ensure_schedule_instances(test.org('TEST_ORG'), array[test.emp('EMP01'), test.emp('EMP02')],
  pg_temp.m(), (pg_temp.m() + interval '1 month - 1 day')::date);
create temporary table wd as
  select employee_id, shift_date, id, start_at, end_at,
         row_number() over (partition by employee_id order by shift_date) as n
  from hrms.work_schedule_instances
  where employee_id in (test.emp('EMP01'), test.emp('EMP02')) and is_required and kind = 'workday'
    and shift_date between pg_temp.m() and (pg_temp.m() + interval '1 month - 1 day')::date;
-- EMP01 works every day; the first five days 45 minutes late (grace is 30).
insert into hrms.attendance_sessions (org_id, employee_id, schedule_instance_id, shift_date, state, effective_in_at, effective_out_at)
select test.org('TEST_ORG'), employee_id, id, shift_date, 'closed',
       start_at + case when n <= 5 then interval '45 minutes' else interval '0' end, end_at
from wd where employee_id = test.emp('EMP01');

create or replace function pg_temp.ded(p_code text) returns jsonb language sql security definer as $$
  select summary from hrms.month_deductions(test.org('TEST_ORG'), array[test.emp(p_code)], pg_temp.m(), now());
$$;

-- Late warnings: the 3rd late of the month warns, the 4th cuts a day.
select hrms.notify_punch(test.org('TEST_ORG'), test.emp('EMP01'), gen_random_uuid(), 'IN',
  (select start_at + interval '45 minutes' from wd where employee_id = test.emp('EMP01') and n = 3), 'Asia/Kolkata',
  true, 900, false, 0);
select hrms.notify_punch(test.org('TEST_ORG'), test.emp('EMP01'), gen_random_uuid(), 'IN',
  (select start_at + interval '45 minutes' from wd where employee_id = test.emp('EMP01') and n = 4), 'Asia/Kolkata',
  true, 900, false, 0);
select test.eq((select count(*)::integer from hrms.notifications where recipient_id = test.emp('EMP01')
                and kind = 'attendance.late_warning'), 1, 'DED-001 third late of the month warns the employee');
select test.eq((select count(*)::integer from hrms.notifications where recipient_id = test.emp('EMP01')
                and kind = 'attendance.late_penalty'), 1, 'DED-001 fourth late tells the employee a day is cut');

select test.eq((pg_temp.ded('EMP01') ->> 'late_days')::integer, 5, 'DED-002 five unexcused late days');
select test.eq((pg_temp.ded('EMP01') ->> 'late_penalty_days')::integer, 1, 'DED-002 every 4 lates = 1 day');
select test.eq((pg_temp.ded('EMP01') ->> 'lates_until_next_cut')::integer, 3, 'DED-002 3 more lates until the next cut');
select test.eq((pg_temp.ded('EMP01') ->> 'unpaid_without_permission_days')::numeric, 0::numeric, 'DED-003 no absences');

insert into hrms.late_excuses (org_id, employee_id, shift_date, approved_by)
select test.org('TEST_ORG'), employee_id, shift_date, test.emp('HR01') from wd where employee_id = test.emp('EMP01') and n <= 2;
select test.eq((pg_temp.ded('EMP01') ->> 'late_days')::integer, 3, 'DED-004 excused lates do not count');
select test.eq((pg_temp.ded('EMP01') ->> 'excused_late_days')::integer, 2, 'DED-004 excused lates are reported');
select test.eq((pg_temp.ded('EMP01') ->> 'late_penalty_days')::integer, 0, 'DED-004 excusing brings the cut back to zero');

-- EMP02 never came: every working day is unpaid without permission; one day
-- is approved unpaid leave instead (with permission).
insert into hrms.leave_types (org_id, code, name, paid) values (test.org('TEST_ORG'), 'UL', 'Unpaid leave', false);
insert into hrms.leave_types (org_id, code, name, paid, requires_attachment, attachment_class)
values (test.org('TEST_ORG'), 'ML', 'Medical leave', true, true, 'medical');
select test.eq((select array_agg(category order by code) from hrms.leave_types where org_id = test.org('TEST_ORG')
                and code in ('ML', 'UL')), array['medical', 'unpaid'], 'DED-005 leave category derived from the type');
create temporary table ul (id uuid, start_date date);
with x as (
  insert into hrms.requests (org_id, employee_id, kind, state, leave_type_id, start_date, end_date, units)
  select test.org('TEST_ORG'), test.emp('EMP02'), 'leave', 'approved', lt.id, w.shift_date, w.shift_date, 2
  from hrms.leave_types lt, wd w where lt.code = 'UL' and lt.org_id = test.org('TEST_ORG')
    and w.employee_id = test.emp('EMP02') and w.n = 1
  returning id, start_date)
insert into ul select * from x;
insert into hrms.leave_day_slots (org_id, employee_id, request_id, revision_no, day, slot, slot_range, state)
select test.org('TEST_ORG'), test.emp('EMP02'), id, 1, start_date, 'FULL', hrms.slot_range('FULL'), 'approved' from ul;
insert into hrms.salary_profiles (employee_id, org_id, monthly_salary) values (test.emp('EMP02'), test.org('TEST_ORG'), 30000);

create temporary table e2 as select pg_temp.ded('EMP02') as s,
  (select count(*) from wd where employee_id = test.emp('EMP02'))::numeric as workdays;
select test.eq((select (s ->> 'unpaid_with_permission_days')::numeric from e2), 1::numeric,
  'DED-006 approved unpaid leave = with permission');
select test.eq((select (s ->> 'unpaid_without_permission_days')::numeric from e2), (select workdays - 1 from e2),
  'DED-007 days absent without leave = without permission');
select test.eq((select (s ->> 'cut_days')::numeric from e2), (select workdays from e2), 'DED-008 cut days add up');
select test.eq((select (s ->> 'estimated_deduction')::numeric from e2),
  (select round(30000 / (s ->> 'days_in_month')::numeric * workdays, 2) from e2),
  'DED-009 estimate = salary / days in month x cut days');

select test.login('EMP01');
select test.throws(format('select public.get_month_summary(%L, %L)', test.emp('EMP02'), pg_temp.m()), 'ACCESS_DENIED',
  'DED-010 employees see only their own month');
select test.ok((public.get_month_summary(null, pg_temp.m()) -> 'data') ? 'estimated_deduction',
  'DED-010 own month includes the estimate');
select test.login('HR01');
create temporary table hrt as select public.get_month_deductions(pg_temp.m(), null, 50, 0) -> 'data' -> 'rows' as rows;
select test.ok((select bool_and(coalesce(prev_cut, cut) >= cut) from (
                  select (r ->> 'cut_days')::numeric as cut,
                         lag((r ->> 'cut_days')::numeric) over (order by i) as prev_cut
                  from jsonb_array_elements((select rows from hrt)) with ordinality t(r, i)) z),
  'DED-010 HR table lists the biggest deduction first');
select test.eq((select (r ->> 'cut_days')::numeric from jsonb_array_elements((select rows from hrt)) r
                where r -> 'employee' ->> 'code' = 'EMP01'), 0::numeric, 'DED-010 EMP01 has no cut this month');

-- ============================================================ medical certificate expiry
select test.as_admin_db();
create temporary table mr (id uuid);
with x as (
  insert into hrms.file_records (org_id, owner_employee_id, class)
  values (test.org('TEST_ORG'), test.emp('EMP01'), 'medical_attachment'),
         (test.org('TEST_ORG'), test.emp('EMP01'), 'medical_attachment')
  returning id)
insert into mr select * from x;
insert into hrms.file_versions (org_id, file_record_id, version_no, state, object_key, size_bytes, validated_at)
select test.org('TEST_ORG'), id, 1, 'validated', 'med/' || id, 100,
       case when row_number() over (order by id) = 1 then now() - interval '8 days' else now() - interval '1 day' end
from mr;
select test.eq(hrms.expire_medical_attachments(), 1, 'MED-001 only certificates older than 7 days expire');
select test.eq((select count(*)::integer from hrms.file_versions v join mr on mr.id = v.file_record_id
                where v.state = 'deleted' and (v.tombstone ->> 'expired')::boolean), 1, 'MED-002 version marked deleted');
select test.eq((select count(*)::integer from hrms.file_purge_queue q join hrms.file_versions v on v.id = q.file_version_id
                join mr on mr.id = v.file_record_id), 1, 'MED-003 stored file queued for deletion');

-- ============================================================ unpaid leave on offer
-- UL-001..005: an organisation whose only unpaid type is switched off gets it
-- switched back on, so "unpaid leave with permission" can be applied for.
select test.as_admin_db();
select test.org('UL_ORG');
insert into hrms.leave_types (org_id, code, name, paid, active, created_at) values
  (test.org('UL_ORG'), 'LWP', 'Leave without pay', false, false, now() - interval '2 days'),
  (test.org('UL_ORG'), 'UL', 'Unpaid leave', false, false, now() - interval '1 day'),
  (test.org('UL_ORG'), 'PL', 'Paid leave', true, false, now());
-- Every other organisation already offers it.
update hrms.leave_types set active = true where org_id <> test.org('UL_ORG') and category = 'unpaid';
select test.eq(hrms.ensure_unpaid_leave_type(), 1, 'UL-001 switches on unpaid leave only where none is on');
select test.eq((select array_agg(code || ':' || active order by code) from hrms.leave_types
                where org_id = test.org('UL_ORG')), array['LWP:false', 'PL:false', 'UL:true'],
  'UL-002 one unpaid type (UL first) is switched on; other types are untouched');
select test.eq((select count(*)::integer from hrms.leave_types where org_id = test.org('TEST_ORG')
                and category = 'unpaid' and active), 1, 'UL-003 an organisation that already offers it is unchanged');
select test.eq(hrms.ensure_unpaid_leave_type(), 0, 'UL-004 running it again changes nothing');
select test.login('EMP01');
select test.ok(exists (select 1 from jsonb_array_elements(public.list_leave_types(false) -> 'data') x
                where x ->> 'code' = 'UL' and (x ->> 'paid')::boolean = false),
  'UL-005 employees see unpaid leave in the apply list');
select test.throws('select hrms.ensure_unpaid_leave_type()', '42501', 'UL-005 not callable by app users');

rollback;
