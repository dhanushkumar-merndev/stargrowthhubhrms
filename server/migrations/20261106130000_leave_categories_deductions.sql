-- [web-hrms] Ported from ~/Documents/Projects/September/HRMS/hrms/supabase/migrations/20261106130000_leave_categories_deductions.sql
-- [web-hrms]   unchanged

-- =============================================================================
-- Leave categories, the late rule and the monthly deduction summary
-- (owner decisions 2026-11-06).
--
--   * Leave category is derived from the type: unpaid / medical / paid.
--     Every organisation gets Paid leave (PL), Medical leave (ML, certificate
--     required) and Unpaid leave (UL) if it has none of that category.
--   * Medical certificates are temporary: deleted 7 days after upload.
--   * Late rule: per calendar month, every 4 unexcused late days = 1 day cut.
--     Approved late arrival requests excuse the day.
--   * Unpaid without permission = a past required workday with no punch and
--     no approved leave (status 'absent').
--   * Estimated deduction = monthly salary / days in month x cut days. No
--     payroll is run; HR uses the figure when preparing the payslip.
-- =============================================================================

alter table hrms.leave_types add column category text generated always as (
  case when not paid then 'unpaid' when attachment_class = 'medical' then 'medical' else 'paid' end
) stored;

-- Standard types for existing organisations (no-op where a category exists).
insert into hrms.leave_types (org_id, code, name, paid, half_day_allowed, requires_attachment, attachment_class,
                              backdate_days)
select o.id, t.code, t.name, t.paid, true, t.requires_attachment, t.attachment_class, t.backdate_days
from hrms.organizations o
cross join (values
  ('PL', 'Paid leave', true, false, 'general', 7, 'paid'),
  ('ML', 'Medical leave', true, true, 'medical', 14, 'medical'),
  ('UL', 'Unpaid leave', false, false, 'general', 7, 'unpaid')
) as t(code, name, paid, requires_attachment, attachment_class, backdate_days, category)
where not exists (select 1 from hrms.leave_types lt where lt.org_id = o.id and lt.category = t.category and lt.active)
  and not exists (select 1 from hrms.leave_types lt where lt.org_id = o.id and lt.code = t.code);

-- -----------------------------------------------------------------------------
-- Medical certificates: deleted 7 days after upload (tick, bounded batch).
-- -----------------------------------------------------------------------------
create or replace function hrms.expire_medical_attachments() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  create temporary table if not exists pg_temp.medical_due (
    id uuid, org_id uuid, file_record_id uuid, object_key text, size_bytes bigint) on commit drop;
  truncate pg_temp.medical_due;
  insert into pg_temp.medical_due
  select v.id, v.org_id, v.file_record_id, v.object_key, coalesce(v.size_bytes, 0)
  from hrms.file_versions v
  join hrms.file_records r on r.id = v.file_record_id
  where r.class = 'medical_attachment'
    and v.state in ('validated', 'published', 'superseded')
    and coalesce(v.validated_at, v.created_at) < now() - interval '7 days'
    and (v.pinned_until is null or v.pinned_until < now())
  order by v.id
  limit 500
  for update of v skip locked;
  get diagnostics v_count = row_count;
  if v_count = 0 then return 0; end if;

  insert into hrms.file_purge_queue (org_id, file_version_id, object_key)
  select org_id, id, object_key from pg_temp.medical_due where object_key is not null;
  update hrms.file_versions v
     set state = 'deleted', deleted_at = now(),
         tombstone = jsonb_build_object('sha256', v.sha256, 'size_bytes', v.size_bytes, 'removed', true,
                                        'expired', true, 'deleted_at', now())
    from pg_temp.medical_due d where v.id = d.id;
  update hrms.storage_ledger l set used_bytes = greatest(0, l.used_bytes - x.total), updated_at = now()
    from (select org_id, sum(size_bytes) as total from pg_temp.medical_due group by org_id) x
   where l.org_id = x.org_id;
  update hrms.file_records r set removed_at = coalesce(r.removed_at, now()), version = r.version + 1
   where r.id in (select file_record_id from pg_temp.medical_due)
     and not exists (select 1 from hrms.file_versions v where v.file_record_id = r.id
                     and v.state in ('validated', 'published', 'superseded'));
  return v_count;
end;
$$;

create or replace function public.internal_maintenance_tick() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run bigint;
  v_rolled integer;
  v_staging jsonb;
  v_finals jsonb;
  v_expired integer;
  v_medical integer;
  v_org record;
begin
  insert into hrms.maintenance_runs (kind) values ('tick') returning id into v_run;

  delete from hrms.punch_challenges where expires_at < now() - interval '1 day';
  delete from hrms.device_challenges where expires_at < now() - interval '1 day';

  with expired as (
    select v.id, v.org_id, v.reserved_bytes, v.staging_object_key, v.object_key
    from hrms.file_versions v
    where (v.state = 'requested' and v.upload_expires_at < now() - interval '5 minutes')
       or (v.state = 'quarantined' and v.created_at < now() - interval '1 hour')
    order by v.id
    limit 200
    for update skip locked
  ),
  upd as (
    update hrms.file_versions v
       set state = 'rejected', validation_error = 'Upload expired before completion', reserved_bytes = 0
      from expired e where v.id = e.id
    returning e.org_id, e.reserved_bytes, e.staging_object_key, e.object_key
  ),
  led as (
    update hrms.storage_ledger l set reserved_bytes = greatest(0, l.reserved_bytes - x.total), updated_at = now()
      from (select org_id, sum(reserved_bytes) as total from upd group by org_id) x
     where l.org_id = x.org_id
    returning l.org_id
  )
  select coalesce(jsonb_agg(staging_object_key) filter (where staging_object_key is not null), '[]'::jsonb),
         coalesce(jsonb_agg(object_key) filter (where object_key is not null), '[]'::jsonb),
         count(*)
    into v_staging, v_finals, v_expired
  from upd;

  v_medical := hrms.expire_medical_attachments();

  update hrms.attendance_sessions s
     set state = 'needs_correction', needs_correction_reason = 'missing_out', version = s.version + 1
    from hrms.work_schedule_instances w
   where s.state = 'open' and w.id = s.schedule_instance_id
     and w.end_at + make_interval(secs => w.checkout_extension_seconds) < now();
  get diagnostics v_rolled = row_count;

  for v_org in select id from hrms.organizations loop
    perform hrms.ensure_schedule_instances(v_org.id, hrms.active_employee_ids(v_org.id),
                                           hrms.org_today(v_org.id), hrms.org_today(v_org.id) + 1);
  end loop;

  perform set_config('hrms.retention_purge', 'on', true);
  delete from hrms.rate_limit_buckets where window_start < now() - interval '1 day';
  delete from hrms.security_events where created_at < now() - interval '180 days';
  perform set_config('hrms.retention_purge', 'off', true);
  delete from hrms.punch_rejections where created_at < now() - interval '180 days';
  delete from hrms.idempotency_records where created_at < now() - interval '30 days';

  update hrms.maintenance_runs set finished_at = now(), ok = true,
    detail = jsonb_build_object('rolled_over_sessions', v_rolled, 'expired_uploads', v_expired,
                                'expired_medical', v_medical)
  where id = v_run;
  return jsonb_build_object('run_id', v_run, 'staging_keys', v_staging, 'final_keys', v_finals,
                            'rolled_over_sessions', v_rolled, 'expired_uploads', v_expired,
                            'expired_medical', v_medical);
end;
$$;

-- -----------------------------------------------------------------------------
-- Attendance rows carry the excuse and the leave category.
-- -----------------------------------------------------------------------------
create or replace function hrms.attendance_row_json(r hrms.attendance_row) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'employee_id', r.employee_id, 'shift_date', r.shift_date, 'instance_id', r.instance_id,
    'kind', r.kind, 'is_required', r.is_required, 'status', r.status,
    'start_at', r.start_at, 'end_at', r.end_at, 'split_at', r.split_at,
    'lunch_start_at', r.lunch_start_at, 'lunch_end_at', r.lunch_end_at, 'lunch_paid', r.lunch_paid,
    'checkout_closes_at', r.checkout_closes_at, 'timezone', r.timezone,
    'session_id', r.session_id, 'session_state', r.session_state,
    'effective_in_at', r.effective_in_at, 'effective_out_at', r.effective_out_at,
    'effective_source', r.effective_source, 'effective_revision', r.effective_revision,
    'leave_slots', r.leave_slots,
    'required_start', (r.calc).required_start, 'required_end', (r.calc).required_end,
    'required_seconds', (r.calc).required_seconds, 'presence_seconds', (r.calc).presence_seconds,
    'credited_seconds', (r.calc).credited_seconds, 'shortfall_seconds', (r.calc).shortfall_seconds,
    'extra_seconds', (r.calc).extra_seconds, 'is_late', (r.calc).is_late,
    'late_seconds', (r.calc).late_seconds, 'is_early_departure', (r.calc).is_early_departure,
    'early_seconds', (r.calc).early_seconds, 'leave_conflict_seconds', (r.calc).leave_conflict_seconds,
    -- 'outside' = outside work (HR/Admin), 'wfh' = approved work from home.
    'work_mode', case when r.effective_source in ('outside', 'wfh') then r.effective_source end,
    'outside_reason', case when r.effective_source in ('outside', 'wfh') then
      (select o.reason from hrms.outside_work o
       where o.employee_id = r.employee_id and o.work_date = r.shift_date and o.revoked_at is null) end,
    'late_excused', case when (r.calc).is_late then exists (
      select 1 from hrms.late_excuses x
      where x.employee_id = r.employee_id and x.shift_date = r.shift_date and x.revoked_at is null) else false end,
    'leave_category', case when r.leave_slots > 0 then
      (select lt.category from hrms.leave_day_slots ds
       join hrms.requests rq on rq.id = ds.request_id
       join hrms.leave_types lt on lt.id = rq.leave_type_id
       where ds.employee_id = r.employee_id and ds.day = r.shift_date and ds.state = 'approved'
       order by case lt.category when 'unpaid' then 0 when 'medical' then 1 else 2 end limit 1) end
  );
$$;

create or replace function hrms.attendance_totals(p_rows jsonb) returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'required_seconds', coalesce(sum((r ->> 'required_seconds')::integer)
                                   filter (where r ->> 'status' in ('present', 'absent', 'leave')), 0),
    'credited_seconds', coalesce(sum((r ->> 'credited_seconds')::integer)
                                   filter (where r ->> 'status' = 'present'), 0),
    'shortfall_seconds', coalesce(sum((r ->> 'shortfall_seconds')::integer)
                                    filter (where r ->> 'status' in ('present', 'absent')), 0),
    'extra_seconds', coalesce(sum((r ->> 'extra_seconds')::integer) filter (where r ->> 'status' = 'present'), 0),
    'present_days', count(*) filter (where r ->> 'status' = 'present'),
    'absent_days', count(*) filter (where r ->> 'status' = 'absent'),
    'late_days', count(*) filter (where (r ->> 'is_late')::boolean
                                    and not coalesce((r ->> 'late_excused')::boolean, false)
                                    and r ->> 'status' in ('present', 'in_progress', 'needs_correction')),
    'excused_late_days', count(*) filter (where (r ->> 'is_late')::boolean
                                            and coalesce((r ->> 'late_excused')::boolean, false)
                                            and r ->> 'status' in ('present', 'in_progress', 'needs_correction')),
    'leave_days', count(*) filter (where r ->> 'status' = 'leave'),
    'outside_days', count(*) filter (where r ->> 'effective_source' = 'outside'),
    'wfh_days', count(*) filter (where r ->> 'effective_source' = 'wfh'),
    'unresolved_days', count(*) filter (where r ->> 'status' in ('needs_correction', 'in_progress')),
    'is_partial', coalesce(bool_or(r ->> 'status' in ('needs_correction', 'in_progress')), false))
  from jsonb_array_elements(p_rows) r;
$$;

-- -----------------------------------------------------------------------------
-- Monthly deduction summary (one set-based pass per call).
-- -----------------------------------------------------------------------------
create or replace function hrms.month_deductions(
  p_org uuid, p_employee_ids uuid[], p_month date, p_now timestamptz
) returns table (employee_id uuid, summary jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select date_trunc('month', p_month)::date as m_from,
           (date_trunc('month', p_month) + interval '1 month - 1 day')::date as m_to,
           least((date_trunc('month', p_month) + interval '1 month - 1 day')::date, hrms.org_today(p_org)) as upto
  ),
  rows as (
    select r.employee_id, r.status, (r.calc).is_late as is_late, r.leave_slots, r.effective_source,
           exists (select 1 from hrms.late_excuses x where x.employee_id = r.employee_id
                   and x.shift_date = r.shift_date and x.revoked_at is null) as excused
    from bounds b, hrms.attendance_rows(p_org, p_employee_ids, b.m_from, b.upto, p_now) r
    where b.upto >= b.m_from
  ),
  att as (
    select employee_id,
           count(*) filter (where status = 'present') as present_days,
           count(*) filter (where is_late and not excused
                              and status in ('present', 'in_progress', 'needs_correction')) as late_days,
           count(*) filter (where is_late and excused
                              and status in ('present', 'in_progress', 'needs_correction')) as excused_late_days,
           coalesce(sum(case when leave_slots in (1, 2) then 0.5 else 1 end) filter (where status = 'absent'), 0)
             as absent_days,
           count(*) filter (where effective_source = 'outside') as outside_days,
           count(*) filter (where effective_source = 'wfh') as wfh_days
    from rows group by employee_id
  ),
  lv as (
    select ds.employee_id, lt.category, sum(case ds.slot when 'FULL' then 1.0 else 0.5 end) as days
    from bounds b
    join hrms.leave_day_slots ds on ds.day between b.m_from and b.upto
    join hrms.requests rq on rq.id = ds.request_id
    join hrms.leave_types lt on lt.id = rq.leave_type_id
    where ds.employee_id = any(p_employee_ids) and ds.state = 'approved'
    group by ds.employee_id, lt.category
  ),
  per as (
    select e.id as employee_id, b.m_from, b.m_to, b.upto,
           extract(day from b.m_to)::integer as days_in_month,
           coalesce(a.present_days, 0) as present_days,
           coalesce(a.late_days, 0) as late_days,
           coalesce(a.excused_late_days, 0) as excused_late_days,
           coalesce(a.late_days, 0) / 4 as late_penalty_days,
           coalesce(a.absent_days, 0) as unpaid_without_days,
           coalesce((select days from lv where lv.employee_id = e.id and lv.category = 'unpaid'), 0) as unpaid_with_days,
           coalesce((select days from lv where lv.employee_id = e.id and lv.category = 'paid'), 0) as paid_leave_days,
           coalesce((select days from lv where lv.employee_id = e.id and lv.category = 'medical'), 0) as medical_leave_days,
           coalesce(a.outside_days, 0) as outside_days,
           coalesce(a.wfh_days, 0) as wfh_days,
           sp.monthly_salary, coalesce(sp.currency, 'INR') as currency
    from bounds b
    cross join unnest(p_employee_ids) as u(id)
    join hrms.employees e on e.id = u.id
    left join att a on a.employee_id = e.id
    left join hrms.salary_profiles sp on sp.employee_id = e.id
  )
  select p.employee_id, jsonb_build_object(
    'month', p.m_from, 'counted_to', p.upto, 'days_in_month', p.days_in_month,
    'present_days', p.present_days,
    'late_days', p.late_days, 'excused_late_days', p.excused_late_days,
    'late_penalty_days', p.late_penalty_days,
    'lates_until_next_cut', 4 - (p.late_days % 4),
    'unpaid_with_permission_days', p.unpaid_with_days,
    'unpaid_without_permission_days', p.unpaid_without_days,
    'paid_leave_days', p.paid_leave_days, 'medical_leave_days', p.medical_leave_days,
    'outside_days', p.outside_days, 'wfh_days', p.wfh_days,
    'cut_days', p.late_penalty_days + p.unpaid_with_days + p.unpaid_without_days,
    'monthly_salary', p.monthly_salary, 'currency', p.currency,
    'per_day_amount', case when p.monthly_salary is not null
                           then round(p.monthly_salary / p.days_in_month, 2) end,
    'estimated_deduction', case when p.monthly_salary is not null
      then round(p.monthly_salary / p.days_in_month
                 * (p.late_penalty_days + p.unpaid_with_days + p.unpaid_without_days), 2) end)
  from per p;
$$;

-- Own month (any employee) or anyone's (HR/Admin).
create or replace function public.get_month_summary(p_employee_id uuid default null, p_month date default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_emp uuid := coalesce(p_employee_id, v_actor.employee_id);
  v_month date := date_trunc('month', coalesce(p_month, hrms.org_today(v_actor.org_id)))::date;
  v_summary jsonb;
  v_own boolean := v_emp = v_actor.employee_id;
begin
  if not v_own and not (hrms.has_perm(v_actor, 'reports.org')
                        and exists (select 1 from hrms.employees where id = v_emp and org_id = v_actor.org_id)) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  perform hrms.ensure_schedule_instances(v_actor.org_id, array[v_emp], v_month,
    least((v_month + interval '1 month - 1 day')::date, hrms.org_today(v_actor.org_id)));
  select d.summary into v_summary from hrms.month_deductions(v_actor.org_id, array[v_emp], v_month, clock_timestamp()) d;
  -- Money only for the owner and payroll managers.
  if not v_own and not hrms.can_manage_payroll(v_actor) then
    v_summary := v_summary - 'monthly_salary' - 'per_day_amount' - 'estimated_deduction';
  end if;
  return hrms.ok(v_summary || jsonb_build_object('employee', (
    select jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name,
                              'position_label', e.position_label, 'designation', e.designation)
    from hrms.employees e where e.id = v_emp)));
end;
$$;

-- HR/Admin: every employee's deductions for a month, highest first.
create or replace function public.get_month_deductions(
  p_month date default null, p_search text default null, p_limit integer default 50, p_offset integer default 0
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_month date := date_trunc('month', coalesce(p_month, hrms.org_today(v_actor.org_id)))::date;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_ids uuid[];
  v_rows jsonb;
  v_totals jsonb;
begin
  if not hrms.can_manage_payroll(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  select array_agg(e.id) into v_ids from hrms.employees e
  where e.org_id = v_actor.org_id and e.status <> 'pending'
    and e.join_date <= (v_month + interval '1 month - 1 day')::date
    and (e.end_date is null or e.end_date >= v_month)
    and (v_term is null or e.employee_code like upper(hrms.like_escape(v_term)) || '%'
         or lower(e.full_name) like '%' || lower(hrms.like_escape(v_term)) || '%');
  if v_ids is null then
    return hrms.ok(jsonb_build_object('month', v_month, 'rows', '[]'::jsonb, 'total', 0));
  end if;
  perform hrms.ensure_schedule_instances(v_actor.org_id, v_ids, v_month,
    least((v_month + interval '1 month - 1 day')::date, hrms.org_today(v_actor.org_id)));
  create temporary table if not exists pg_temp.month_rows (employee_id uuid, summary jsonb) on commit drop;
  truncate pg_temp.month_rows;
  insert into pg_temp.month_rows
  select * from hrms.month_deductions(v_actor.org_id, v_ids, v_month, clock_timestamp());

  select jsonb_build_object(
    'employees', count(*),
    'late_penalty_days', coalesce(sum((summary ->> 'late_penalty_days')::numeric), 0),
    'unpaid_with_permission_days', coalesce(sum((summary ->> 'unpaid_with_permission_days')::numeric), 0),
    'unpaid_without_permission_days', coalesce(sum((summary ->> 'unpaid_without_permission_days')::numeric), 0),
    'cut_days', coalesce(sum((summary ->> 'cut_days')::numeric), 0),
    'estimated_deduction', coalesce(sum((summary ->> 'estimated_deduction')::numeric), 0))
    into v_totals from pg_temp.month_rows;

  select coalesce(jsonb_agg(x.j order by x.cut desc, x.name, x.id), '[]'::jsonb) into v_rows
  from (
    select m.summary || jsonb_build_object('employee', jsonb_build_object(
             'id', e.id, 'code', e.employee_code, 'name', e.full_name, 'status', e.status,
             'position_label', e.position_label)) as j,
           (m.summary ->> 'cut_days')::numeric as cut, e.full_name as name, e.id
    from pg_temp.month_rows m join hrms.employees e on e.id = m.employee_id
    order by (m.summary ->> 'cut_days')::numeric desc, e.full_name, e.id
    limit v_limit offset v_offset
  ) x;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'report.deductions_viewed', 'organization',
    v_actor.org_id, jsonb_build_object('month', v_month, 'employees', cardinality(v_ids)), 'access');
  return hrms.ok(jsonb_build_object('month', v_month, 'rows', v_rows, 'total', cardinality(v_ids),
                                    'totals', v_totals, 'limit', v_limit, 'offset', v_offset));
end;
$$;

-- -----------------------------------------------------------------------------
-- Punch notifications: HR/Admin on every punch (unchanged) plus the late
-- warnings for the employee: the 3rd late of a month warns, every 4th cuts.
-- -----------------------------------------------------------------------------
create or replace function hrms.notify_punch(
  p_org uuid,
  p_employee uuid,
  p_event_id uuid,
  p_action text,
  p_at timestamptz,
  p_timezone text,
  p_is_late boolean,
  p_late_seconds integer,
  p_is_early_departure boolean,
  p_early_seconds integer
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_title text;
  v_body text;
  v_day date := (p_at at time zone coalesce(p_timezone, 'Asia/Kolkata'))::date;
  v_lates integer;
begin
  select left(e.full_name, 90) into v_name from hrms.employees e where e.id = p_employee;
  v_title := v_name || case when p_action = 'IN' then ' checked in' else ' checked out' end;
  v_body := case when p_action = 'IN' then 'In at ' else 'Out at ' end
    || btrim(to_char(p_at at time zone coalesce(p_timezone, 'Asia/Kolkata'), 'FMHH12:MI AM'))
    || case
         when p_action = 'IN' and p_is_late then ' · Late by ' || hrms.fmt_minutes(p_late_seconds)
         when p_action = 'IN' then ' · On time'
         when p_action = 'OUT' and p_is_early_departure then ' · Left early by ' || hrms.fmt_minutes(p_early_seconds)
         else ''
       end;

  perform hrms.notify(p_org, e.id, 'attendance.punch_' || lower(p_action), v_title, v_body,
    '/reports/hours?employee=' || p_employee::text,
    jsonb_build_object('employee_id', p_employee, 'action', p_action, 'at', p_at),
    md5(p_event_id::text || ':punch:' || e.id::text)::uuid)
  from hrms.employees e
  where e.org_id = p_org
    and e.status = 'active'
    and e.id <> p_employee
    and hrms.employee_roles(e.id) && array['hr', 'admin'];

  if p_action = 'IN' and p_is_late then
    select count(*) into v_lates
    from hrms.attendance_rows(p_org, array[p_employee], date_trunc('month', v_day)::date, v_day, p_at) r
    where (r.calc).is_late and r.status in ('present', 'in_progress', 'needs_correction')
      and not exists (select 1 from hrms.late_excuses x where x.employee_id = r.employee_id
                      and x.shift_date = r.shift_date and x.revoked_at is null);
    if v_lates > 0 and v_lates % 4 = 0 then
      perform hrms.notify(p_org, p_employee, 'attendance.late_penalty', 'Late ' || v_lates || ' times this month',
        'Every 4 late days cost 1 day of salary. This month: ' || (v_lates / 4) || ' day(s). '
          || 'If you had a reason, send a late arrival request.', '/attendance', null,
        md5(p_event_id::text || ':late_penalty')::uuid);
    elsif v_lates % 4 = 3 then
      perform hrms.notify(p_org, p_employee, 'attendance.late_warning', 'Late ' || v_lates || ' times this month',
        'One more late day this month means 1 day of salary is cut. '
          || 'If you had a reason, send a late arrival request.', '/attendance', null,
        md5(p_event_id::text || ':late_warning')::uuid);
    end if;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Daily: yesterday's unexcused absences (unpaid without permission).
-- -----------------------------------------------------------------------------
create or replace function hrms.notify_absences(p_org uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := hrms.org_today(p_org) - 1;
  v_ids uuid[] := hrms.active_employee_ids(p_org);
  v_count integer;
begin
  if cardinality(v_ids) = 0 then return 0; end if;
  perform hrms.ensure_schedule_instances(p_org, v_ids, v_day, v_day);
  with absent as (
    select r.employee_id from hrms.attendance_rows(p_org, v_ids, v_day, v_day, now()) r
    where r.status = 'absent'
  )
  select count(hrms.notify(p_org, a.employee_id, 'attendance.absent', 'Marked absent ' || to_char(v_day, 'FMDD Mon'),
    'No check-in or approved leave. It counts as unpaid leave without permission. '
      || 'If this is wrong, request a correction or contact HR.',
    '/attendance/day?date=' || v_day::text, null, md5(a.employee_id::text || ':absent:' || v_day::text)::uuid))
    into v_count
  from absent a;
  return v_count;
end;
$$;

create or replace function hrms.daily_extras() returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org record;
begin
  for v_org in select id from hrms.organizations loop
    perform hrms.ensure_archive_periods(v_org.id);
    perform hrms.notify_absences(v_org.id);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- One attendance day: excuse state and related requests.
-- -----------------------------------------------------------------------------
create or replace function public.get_attendance_day(p_employee_id uuid, p_shift_date date) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_emp uuid := coalesce(p_employee_id, v_actor.employee_id);
  v_now timestamptz := clock_timestamp();
  v_row hrms.attendance_row;
  v_own boolean;
  v_detail jsonb;
begin
  if not hrms.can_view_attendance(v_actor, v_emp, p_shift_date) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  v_own := v_emp = v_actor.employee_id;
  perform hrms.ensure_schedule_instances(v_actor.org_id, array[v_emp], p_shift_date, p_shift_date);
  select * into v_row from hrms.attendance_rows(v_actor.org_id, array[v_emp], p_shift_date, p_shift_date, v_now) r;
  if not found then
    return hrms.ok(jsonb_build_object('shift_date', p_shift_date, 'scheduled', false));
  end if;

  v_detail := hrms.attendance_row_json(v_row) || jsonb_build_object(
    'scheduled', true,
    'own', v_own,
    'employee', (select jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name,
                                           'designation', e.designation, 'position_label', e.position_label)
                 from hrms.employees e where e.id = v_emp),
    'shift', (select jsonb_build_object('name', sh.name, 'version_no', sv.version_no,
                                        'effective_from', sv.effective_from, 'start_local', sv.start_local,
                                        'end_local', sv.end_local, 'grace_seconds', sv.grace_seconds,
                                        'lunch_paid', sv.lunch_paid,
                                        'checkout_extension_seconds',
                                          case when sv.checkout_extension_enabled then sv.checkout_extension_seconds else 0 end)
              from hrms.work_schedule_instances w
              join hrms.shift_versions sv on sv.id = w.shift_version_id
              join hrms.shifts sh on sh.id = sv.shift_id
              where w.id = v_row.instance_id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object(
                 'id', ev.id, 'action', ev.action, 'at', ev.server_timestamp,
                 'distance_m', round(ev.distance_m::numeric, 1), 'accuracy_m', round(ev.accuracy_m::numeric, 1),
                 'integrity_level', ev.integrity ->> 'level',
                 'wifi_ssid', ev.integrity ->> 'wifi_ssid',
                 'office_config_version', ev.office_config_version,
                 'latitude', case when v_own then ev.latitude end,
                 'longitude', case when v_own then ev.longitude end) order by ev.server_timestamp), '[]'::jsonb)
               from hrms.attendance_events ev where ev.session_id = v_row.session_id),
    'adjustments', (select coalesce(jsonb_agg(jsonb_build_object(
                      'revision', a.revision, 'effective_in_at', a.effective_in_at,
                      'effective_out_at', a.effective_out_at, 'reason', a.reason, 'created_at', a.created_at,
                      'approved_by', (select e.full_name from hrms.employees e where e.id = a.approved_by))
                      order by a.revision), '[]'::jsonb)
                    from hrms.attendance_adjustments a where a.session_id = v_row.session_id),
    'requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'state', r.state,
                    'submitted_at', r.submitted_at) order by r.created_at desc), '[]'::jsonb)
                 from hrms.requests r where r.employee_id = v_emp
                   and r.state <> 'draft'
                   and ((r.kind in ('correction', 'late_excuse') and r.target_shift_date = p_shift_date)
                        or (r.kind in ('wfh', 'leave') and p_shift_date between r.start_date and r.end_date))
                   and (v_own or hrms.has_perm(v_actor, 'reports.org'))),
    'correction_requests', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'state', r.state,
                              'submitted_at', r.submitted_at) order by r.created_at desc), '[]'::jsonb)
                            from hrms.requests r where r.employee_id = v_emp and r.kind = 'correction'
                              and r.target_shift_date = p_shift_date and (v_own or hrms.has_perm(v_actor, 'reports.org'))),
    'late_excuse', (select jsonb_build_object('approved_by', e.full_name, 'at', x.created_at)
                    from hrms.late_excuses x left join hrms.employees e on e.id = x.approved_by
                    where x.employee_id = v_emp and x.shift_date = p_shift_date and x.revoked_at is null)
  );
  if not v_own then
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'attendance.viewed', 'attendance_day', v_row.instance_id,
      jsonb_build_object('shift_date', p_shift_date), 'access', v_emp);
  end if;
  return hrms.ok(v_detail);
end;
$$;

-- -----------------------------------------------------------------------------
-- Home: role, this month's late/deduction card, pool review count.
-- -----------------------------------------------------------------------------
create or replace function public.get_home_summary() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_now timestamptz := clock_timestamp();
  v_emp hrms.employees;
  v_org hrms.organizations;
  v_today date;
  v_result jsonb;
  v_month jsonb;
begin
  select * into v_emp from hrms.employees where id = v_actor.employee_id;
  select * into v_org from hrms.organizations where id = v_actor.org_id;
  v_today := hrms.org_today(v_org.id);

  select d.summary into v_month
  from hrms.month_deductions(v_org.id, array[v_emp.id], v_today, v_now) d;

  v_result := jsonb_build_object(
    'server_time', v_now,
    'org', jsonb_build_object('name', v_org.name, 'code', v_org.code, 'timezone', v_org.timezone,
                              'support_contact', v_org.support_contact, 'holiday_target', v_org.holiday_target,
                              'require_biometric_punch', v_org.require_biometric_punch),
    'me', jsonb_build_object('id', v_emp.id, 'code', v_emp.employee_code, 'name', v_emp.full_name,
                             'designation', v_emp.designation, 'roles', to_jsonb(v_actor.roles),
                             'role', hrms.primary_role(v_actor.roles), 'position_label', v_emp.position_label,
                             'permissions', to_jsonb(v_actor.permissions),
                             'has_avatar', v_emp.avatar_file_version_id is not null),
    'today', v_today,
    'shift', hrms.current_shift(v_actor, v_now),
    'device', (select jsonb_build_object('device_id', d.id, 'installation_id', d.installation_id,
                                         'attestation_level', d.attestation_level,
                                         'biometric_bound', d.biometric_bound)
               from hrms.devices d where d.employee_id = v_actor.employee_id and d.revoked_at is null),
    'last_punch', (select jsonb_build_object('action', ev.action, 'at', ev.server_timestamp)
                   from hrms.attendance_events ev where ev.employee_id = v_actor.employee_id
                   order by ev.server_timestamp desc, ev.id desc limit 1),
    'exception_days', (select count(*) from hrms.attendance_sessions s
                       where s.employee_id = v_actor.employee_id and s.state = 'needs_correction'
                         and s.shift_date >= v_today - 45
                         and not exists (select 1 from hrms.requests r where r.employee_id = s.employee_id
                                         and r.kind = 'correction' and r.target_shift_date = s.shift_date
                                         and r.state in ('submitted', 'under_review', 'approved'))),
    'upcoming_holidays', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'date', h.holiday_date,
                                                                       'name', h.name) order by h.holiday_date), '[]'::jsonb)
                          from (select h.* from hrms.holidays h
                                where h.org_id = v_org.id and h.state = 'published' and h.holiday_date >= v_today
                                  and (h.office_id is null or h.office_id = (
                                        select a.office_id from hrms.office_assignments a
                                        where a.employee_id = v_actor.employee_id
                                          and daterange(a.effective_from, a.effective_to, '[)') @> v_today))
                                order by h.holiday_date limit 4) h),
    'month', v_month,
    'team', hrms.team_today(v_actor, v_now),
    'pending_reviews', case when hrms.is_hr_or_admin(v_actor)
                              or exists (select 1 from hrms.requests r where r.assigned_reviewer_id = v_actor.employee_id)
                            then hrms.pending_review_count(v_actor) end,
    'unassigned_reviews', case when hrms.is_admin(v_actor) then
                            (select count(*) from hrms.requests r where r.org_id = v_org.id
                               and r.assigned_reviewer_id is null and not hrms.is_pool_kind(r.kind)
                               and r.state in ('submitted', 'under_review', 'withdrawal_pending', 'cancellation_pending'))
                          end,
    'my_open_requests', (select count(*) from hrms.requests r where r.employee_id = v_actor.employee_id
                           and r.state in ('submitted', 'under_review', 'returned')),
    'unread_notifications', (select count(*) from hrms.notifications n
                             where n.recipient_id = v_actor.employee_id and n.read_at is null)
  );
  return hrms.ok(v_result || jsonb_build_object('extras', hrms.home_extras(v_actor, v_today)));
end;
$$;

select hrms.apply_api_grants();
