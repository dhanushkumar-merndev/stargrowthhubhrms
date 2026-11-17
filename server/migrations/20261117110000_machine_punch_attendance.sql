-- Machine punches count for attendance, lateness and the salary estimate.
--
-- Until now hrms.attendance_rows (behind the attendance list, the late rule
-- and the monthly deduction summary) only read app check-ins
-- (attendance_sessions). Everyone punches on the eSSL machine, so nobody was
-- ever marked late and every workday looked absent. Now a day with no app
-- check-in takes its times from hrms.device_attendance_days:
--   in  = HR-corrected in, else the first machine IN
--   out = the day's OUT (machine, automatic close, HR or app)
-- and is labelled effective_source = 'device'. Precedence per day:
-- app check-in > machine punch > outside work / work from home.
--
-- The shift decides everything else, as before: start + grace = late after
-- (General 10:00, 30 min grace -> late from 10:30:01), and every 4 unexcused
-- late days in a month = 1 day of salary.
--
-- The month summary also reports hours worked, days worked and the estimated
-- pay (monthly salary - cut days x salary / days in month), and the machine
-- punch-in notification says when someone is late, with the 3rd-late warning
-- and the 4th-late cut notice the app punch already sent.

create or replace function hrms.attendance_rows(
  p_org uuid, p_employee_ids uuid[], p_from date, p_to date, p_now timestamptz
) returns setof hrms.attendance_row
language sql
stable
security definer
set search_path = ''
as $$
  with slots as (
    select ds.employee_id, ds.day,
           case when bool_or(ds.slot = 'FULL') or (bool_or(ds.slot = 'AM') and bool_or(ds.slot = 'PM')) then 3
                when bool_or(ds.slot = 'AM') then 1
                when bool_or(ds.slot = 'PM') then 2 else 0 end as slots
    from hrms.leave_day_slots ds
    where ds.employee_id = any(p_employee_ids) and ds.day between p_from and p_to and ds.state = 'approved'
    group by ds.employee_id, ds.day
  ),
  dev as (
    select d.employee_id, d.local_date,
           coalesce(d.corrected_in_at, d.first_in_at) as in_at,
           d.out_at
    from hrms.device_attendance_days d
    where d.org_id = p_org and d.employee_id = any(p_employee_ids) and d.local_date between p_from and p_to
      and coalesce(d.corrected_in_at, d.first_in_at) is not null
  ),
  src as (
    select w.*,
           s.id as s_id, s.state as s_state, s.effective_in_at as s_in, s.effective_out_at as s_out,
           s.effective_source as s_source, s.effective_revision as s_rev,
           dv.in_at as d_in, dv.out_at as d_out,
           ow.id as ow_id, ow.kind as ow_kind,
           coalesce(sl.slots, 0) as leave_slots
    from hrms.work_schedule_instances w
    left join hrms.attendance_sessions s on s.schedule_instance_id = w.id
    left join dev dv on s.id is null and dv.employee_id = w.employee_id and dv.local_date = w.shift_date
    left join slots sl on sl.employee_id = w.employee_id and sl.day = w.shift_date
    -- Outside work (HR/Admin) or approved work from home: a working day with
    -- no punches counts as the full shift.
    left join hrms.outside_work ow
      on ow.employee_id = w.employee_id and ow.work_date = w.shift_date and ow.revoked_at is null
     and w.kind in ('workday', 'extra_workday') and s.id is null and dv.in_at is null
    where w.org_id = p_org
      and w.employee_id = any(p_employee_ids)
      and w.shift_date between p_from and p_to
  ),
  eff as (
    select x.*,
           case when x.s_id is not null then x.s_state
                when x.d_in is not null then case when x.d_out is not null then 'closed' else 'open' end
                when x.ow_id is not null and p_now >= x.start_at then 'closed' end as e_state,
           case when x.s_id is not null then x.s_in
                when x.d_in is not null then x.d_in
                when x.ow_id is not null then x.start_at end as e_in,
           case when x.s_id is not null then x.s_out
                when x.d_in is not null then x.d_out
                when x.ow_id is not null then x.end_at end as e_out,
           case when x.s_id is not null then x.s_source
                when x.d_in is not null then 'device'
                when x.ow_id is not null then (case x.ow_kind when 'wfh' then 'wfh' else 'outside' end) end as e_source,
           case when x.s_id is not null then x.s_rev
                when x.d_in is not null or x.ow_id is not null then 0 end as e_rev,
           -- Times the day calculation uses (an open day has no out yet).
           case when x.s_id is not null then x.s_in
                when x.d_in is not null then x.d_in
                when x.ow_id is not null and p_now >= x.start_at then x.start_at end as c_in,
           case when x.s_id is not null then (case when x.s_state = 'closed' then x.s_out end)
                when x.d_in is not null then x.d_out
                when x.ow_id is not null and p_now >= x.start_at then x.end_at end as c_out
    from src x
  )
  select e.employee_id, e.shift_date, e.id, e.kind, e.is_required, e.timezone, e.start_at, e.end_at,
         e.half_split_at, e.lunch_start_at, e.lunch_end_at, e.lunch_paid, e.grace_seconds, e.expected_seconds,
         e.start_at - make_interval(secs => e.early_entry_seconds),
         e.end_at + make_interval(secs => e.checkout_extension_seconds),
         e.office_id,
         e.s_id, e.e_state, e.e_in, e.e_out, e.e_source, e.e_rev,
         e.leave_slots,
         hrms.day_status(e.kind, e.is_required, e.start_at,
                         e.end_at + make_interval(secs => e.checkout_extension_seconds),
                         e.e_state, e.leave_slots, p_now),
         hrms.calc_day(e.is_required, e.start_at, e.end_at, e.half_split_at, e.expected_seconds,
                       e.leave_slots, e.grace_seconds, e.early_credit, e.checkout_extension_seconds,
                       e.c_in, e.c_out)
  from eff e;
$$;

-- Monthly summary: as before, plus days and hours worked and estimated pay.
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
           coalesce((r.calc).presence_seconds, 0) as presence_seconds,
           r.is_required,
           exists (select 1 from hrms.late_excuses x where x.employee_id = r.employee_id
                   and x.shift_date = r.shift_date and x.revoked_at is null) as excused
    from bounds b, hrms.attendance_rows(p_org, p_employee_ids, b.m_from, b.upto, p_now) r
    where b.upto >= b.m_from
  ),
  att as (
    select employee_id,
           count(*) filter (where status = 'present') as present_days,
           count(*) filter (where status in ('present', 'in_progress', 'needs_correction')) as worked_days,
           coalesce(sum(presence_seconds), 0) as worked_seconds,
           count(*) filter (where is_required and status not in ('upcoming', 'holiday', 'weekly_off', 'day_off'))
             as workdays_so_far,
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
           coalesce(a.worked_days, 0) as worked_days,
           coalesce(a.worked_seconds, 0) as worked_seconds,
           coalesce(a.workdays_so_far, 0) as workdays_so_far,
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
  ),
  money as (
    select p.*,
           p.late_penalty_days + p.unpaid_with_days + p.unpaid_without_days as cut_days,
           case when p.monthly_salary is not null then round(p.monthly_salary / p.days_in_month
             * (p.late_penalty_days + p.unpaid_with_days + p.unpaid_without_days), 2) end as deduction
    from per p
  )
  select m.employee_id, jsonb_build_object(
    'month', m.m_from, 'counted_to', m.upto, 'days_in_month', m.days_in_month,
    'present_days', m.present_days,
    'worked_days', m.worked_days, 'worked_seconds', m.worked_seconds, 'workdays_so_far', m.workdays_so_far,
    'late_days', m.late_days, 'excused_late_days', m.excused_late_days,
    'late_penalty_days', m.late_penalty_days,
    'lates_until_next_cut', 4 - (m.late_days % 4),
    'unpaid_with_permission_days', m.unpaid_with_days,
    'unpaid_without_permission_days', m.unpaid_without_days,
    'paid_leave_days', m.paid_leave_days, 'medical_leave_days', m.medical_leave_days,
    'outside_days', m.outside_days, 'wfh_days', m.wfh_days,
    'cut_days', m.cut_days,
    'monthly_salary', m.monthly_salary, 'currency', m.currency,
    'per_day_amount', case when m.monthly_salary is not null
                           then round(m.monthly_salary / m.days_in_month, 2) end,
    'estimated_deduction', m.deduction,
    'estimated_pay', case when m.monthly_salary is not null then greatest(0, m.monthly_salary - m.deduction) end)
  from money m;
$$;

-- Same as before; estimated_pay is money too.
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
    v_summary := v_summary - 'monthly_salary' - 'per_day_amount' - 'estimated_deduction' - 'estimated_pay';
  end if;
  return hrms.ok(v_summary || jsonb_build_object('employee', (
    select jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name,
                              'position_label', e.position_label, 'designation', e.designation)
    from hrms.employees e where e.id = v_emp)));
end;
$$;

-- Machine punch-in notification: says when it is late, and warns on the 3rd
-- late of the month / tells on every 4th (like the app punch).
create or replace function hrms.device_day_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tz text;
  v_label text;
  v_link text := '/attendance/today?date=' || to_char(new.local_date, 'YYYY-MM-DD');
  v_row hrms.attendance_row;
  v_late text := '';
  v_lates integer;
  v_month date;
begin
  if not exists (select 1 from hrms.employees where id = new.employee_id and status = 'active') then
    return null;
  end if;
  select timezone into v_tz from hrms.organizations where id = new.org_id;
  if new.first_in_punch_id is not null and (tg_op = 'INSERT' or old.first_in_punch_id is null)
     and new.first_in_at > now() - interval '3 hours' then
    select d.label into v_label from hrms.device_punch_events p
    join hrms.attendance_devices d on d.serial = p.serial where p.id = new.first_in_punch_id;
    begin
      perform hrms.ensure_schedule_instances(new.org_id, array[new.employee_id], new.local_date, new.local_date);
      select r.* into v_row
      from hrms.attendance_rows(new.org_id, array[new.employee_id], new.local_date, new.local_date, now()) r
      where (r.calc).is_late
        and not exists (select 1 from hrms.late_excuses x where x.employee_id = r.employee_id
                        and x.shift_date = r.shift_date and x.revoked_at is null)
      limit 1;
      if found then
        v_late := ' · Late by ' || hrms.fmt_minutes((v_row.calc).late_seconds);
        v_month := date_trunc('month', new.local_date)::date;
        select count(*) into v_lates
        from hrms.attendance_rows(new.org_id, array[new.employee_id], v_month, new.local_date, now()) r
        where (r.calc).is_late and r.status in ('present', 'in_progress', 'needs_correction')
          and not exists (select 1 from hrms.late_excuses x where x.employee_id = r.employee_id
                          and x.shift_date = r.shift_date and x.revoked_at is null);
      end if;
    exception when others then
      v_late := '';  -- a lateness lookup problem must never block the punch
      v_lates := null;
    end;
    perform hrms.notify(new.org_id, new.employee_id, 'attendance.device_in',
      'You punched in at ' || hrms.fmt_clock(new.first_in_at, v_tz) || v_late,
      coalesce(v_label || '. ', '') || 'Wrong time? Tap to ask for a fix. Forget to punch out later? Do it from here.',
      v_link, jsonb_build_object('date', new.local_date), md5(new.first_in_punch_id::text || ':device_in')::uuid);
    if v_lates is not null and v_lates > 0 and v_lates % 4 = 0 then
      perform hrms.notify(new.org_id, new.employee_id, 'attendance.late_penalty', 'Late ' || v_lates || ' times this month',
        'Every 4 late days cost 1 day of salary. This month: ' || (v_lates / 4) || ' day(s). '
          || 'If you had a reason, send a late arrival request.', '/attendance', null,
        md5(new.first_in_punch_id::text || ':late_penalty')::uuid);
    elsif v_lates is not null and v_lates % 4 = 3 then
      perform hrms.notify(new.org_id, new.employee_id, 'attendance.late_warning', 'Late ' || v_lates || ' times this month',
        'One more late day this month means 1 day of salary is cut. '
          || 'If you had a reason, send a late arrival request.', '/attendance', null,
        md5(new.first_in_punch_id::text || ':late_warning')::uuid);
    end if;
  end if;
  if new.device_out_punch_id is not null and (tg_op = 'INSERT' or old.device_out_punch_id is null)
     and new.device_out_at > now() - interval '3 hours' then
    perform hrms.notify(new.org_id, new.employee_id, 'attendance.device_out',
      'You punched out at ' || hrms.fmt_clock(new.device_out_at, v_tz),
      case when new.worked_minutes is not null then 'Worked ' || hrms.fmt_minutes(new.worked_minutes * 60) || '. ' else '' end || 'Tap if a time is wrong.',
      v_link, jsonb_build_object('date', new.local_date), md5(new.device_out_punch_id::text || ':device_out')::uuid);
  end if;
  return null;
end;
$$;
