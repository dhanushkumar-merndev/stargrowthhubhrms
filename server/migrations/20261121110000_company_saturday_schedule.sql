-- Use the company policy for Saturdays, including on shifts with older Mon–Fri masks.
-- Keep the legacy rule when materializing dates before the rollout for existing orgs.
alter table hrms.organizations add column saturday_policy_from date;
update hrms.organizations set saturday_policy_from = (now() at time zone timezone)::date;

create function hrms.is_saturday_off(p_day date, p_weeks integer) returns boolean
language sql immutable strict
set search_path = ''
as $$
  select extract(isodow from p_day) = 6
     and (p_weeks & (1 << ((extract(day from p_day)::integer - 1) / 7))) <> 0;
$$;

create or replace function hrms.ensure_schedule_instances(
  p_org uuid, p_employee_ids uuid[], p_from date, p_to date
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to < p_from then
    return;
  end if;
  if p_to - p_from > 400 then
    perform hrms.raise_error('RANGE_TOO_LARGE', 'Date range is too large.');
  end if;

  -- A concurrent settings change must see any Saturdays materialized here.
  if p_from + ((6 - extract(isodow from p_from)::integer + 7) % 7) <= p_to then
    perform pg_advisory_xact_lock_shared(hashtextextended('hrms.saturday_policy:' || p_org::text, 0));
  end if;

  with org as (
    select o.timezone, o.saturday_off_weeks, o.saturday_policy_from
    from hrms.organizations o where o.id = p_org
  ),
  emps as (
    select e.id, e.join_date, e.end_date
    from hrms.employees e
    where e.org_id = p_org and e.id = any(p_employee_ids)
  ),
  days as (
    select e.id as employee_id, d::date as day
    from emps e
    cross join lateral generate_series(
      greatest(p_from, e.join_date),
      least(p_to, coalesce(e.end_date, p_to)),
      interval '1 day'
    ) d
  ),
  -- Published version validity ranges, computed once for all shifts.
  versions as (
    select sv.*,
           daterange(sv.effective_from,
                     lead(sv.effective_from) over (partition by sv.shift_id
                                                   order by sv.effective_from, sv.version_no),
                     '[)') as valid
    from hrms.shift_versions sv
    where sv.org_id = p_org and sv.state = 'published'
  ),
  base as (
    select dd.employee_id, dd.day,
           coalesce(ex.shift_id, sa.shift_id) as shift_id,
           ex.kind as exception_kind,
           oa.office_id
    from days dd
    left join hrms.shift_assignments sa
      on sa.employee_id = dd.employee_id
     and daterange(sa.effective_from, sa.effective_to, '[)') @> dd.day
    left join hrms.schedule_exceptions ex
      on ex.employee_id = dd.employee_id and ex.work_date = dd.day
    left join hrms.office_assignments oa
      on oa.employee_id = dd.employee_id
     and daterange(oa.effective_from, oa.effective_to, '[)') @> dd.day
  ),
  hol as (
    select distinct on (b.employee_id, b.day) b.employee_id, b.day, h.id as holiday_id
    from base b
    join hrms.holidays h
      on h.org_id = p_org and h.state = 'published' and h.holiday_date = b.day
     and (h.office_id is null or h.office_id = b.office_id)
    order by b.employee_id, b.day, h.office_id nulls last
  ),
  resolved as (
    select b.employee_id, b.day, b.office_id, b.exception_kind, hol.holiday_id,
           v.id as shift_version_id, v.start_local, v.end_local, v.crosses_midnight,
           v.weekly_mask, v.grace_seconds, v.lunch_start_local, v.lunch_end_local, v.lunch_paid,
           v.early_entry_seconds, v.early_credit,
           case when v.checkout_extension_enabled then v.checkout_extension_seconds else 0 end as ext,
           coalesce(ofc.timezone, org.timezone) as tz,
           not hrms.is_saturday_off(b.day, org.saturday_off_weeks)
             and (
               (v.weekly_mask & (1 << (extract(isodow from b.day)::integer - 1))) <> 0
               or (extract(isodow from b.day) = 6
                   and (org.saturday_policy_from is null or b.day >= org.saturday_policy_from))
             ) as on_weekly_day
    from base b
    cross join org
    join versions v on v.shift_id = b.shift_id and v.valid @> b.day
    left join hol on hol.employee_id = b.employee_id and hol.day = b.day
    left join hrms.offices ofc on ofc.id = b.office_id
  ),
  timed as (
    select r.*,
           ((r.day + r.start_local) at time zone r.tz) as s_at,
           (((r.day + case when r.crosses_midnight then 1 else 0 end) + r.end_local) at time zone r.tz) as e_at,
           case when r.lunch_start_local is null then null else
             (((r.day + case when r.crosses_midnight and r.lunch_start_local < r.start_local then 1 else 0 end)
               + r.lunch_start_local) at time zone r.tz) end as ls_at,
           case when r.lunch_end_local is null then null else
             (((r.day + case when r.crosses_midnight and r.lunch_end_local <= r.start_local then 1 else 0 end)
               + r.lunch_end_local) at time zone r.tz) end as le_at,
           case
             when r.exception_kind = 'day_off' then 'day_off'
             when r.exception_kind = 'extra_workday' then 'extra_workday'
             when r.holiday_id is not null then 'holiday'
             when not r.on_weekly_day then 'weekly_off'
             else 'workday'
           end as kind
    from resolved r
  )
  insert into hrms.work_schedule_instances (
    org_id, employee_id, shift_date, kind, is_required, office_id, shift_version_id, holiday_id,
    timezone, start_at, end_at, lunch_start_at, lunch_end_at, lunch_paid, grace_seconds,
    early_entry_seconds, early_credit, checkout_extension_seconds, expected_seconds, half_split_at
  )
  select p_org, t.employee_id, t.day, t.kind, t.kind in ('workday', 'extra_workday'), t.office_id,
         t.shift_version_id, t.holiday_id, t.tz, t.s_at, t.e_at, t.ls_at, t.le_at, t.lunch_paid,
         t.grace_seconds, t.early_entry_seconds, t.early_credit, t.ext,
         (extract(epoch from (t.e_at - t.s_at))
           - case when t.lunch_paid or t.ls_at is null then 0
                  else extract(epoch from (t.le_at - t.ls_at)) end)::integer,
         -- Half-day split at the midpoint of the paid timeline (10:00–19:00
         -- with paid lunch -> 14:30). With an unpaid lunch the split skips it.
         case
           when t.lunch_paid or t.ls_at is null then t.s_at + (t.e_at - t.s_at) / 2
           else (
             select case when t.s_at + make_interval(secs => half) <= t.ls_at
                         then t.s_at + make_interval(secs => half)
                         else t.s_at + make_interval(secs => half) + (t.le_at - t.ls_at) end
             from (select (extract(epoch from (t.e_at - t.s_at))
                           - extract(epoch from (t.le_at - t.ls_at))) / 2 as half) h
           )
         end
  from timed t
  on conflict (employee_id, shift_date) do nothing;
end;
$$;

-- Allow the Saturday policy to change just the status of current and future Saturdays.
create or replace function hrms.wsi_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if current_setting('hrms.saturday_schedule_update', true) = 'on'
       and extract(isodow from old.shift_date) = 6
       and old.shift_date >= (now() at time zone old.timezone)::date
       and old.kind in ('workday', 'weekly_off')
       and new.kind in ('workday', 'weekly_off')
       and new.is_required = (new.kind = 'workday')
       and (to_jsonb(new) - array['kind', 'is_required']) = (to_jsonb(old) - array['kind', 'is_required']) then
      return new;
    end if;
    raise exception 'HRMS: schedule instances are immutable' using errcode = '42501';
  end if;
  if coalesce(current_setting('hrms.schedule_refresh', true), '') <> 'on'
     or old.shift_date <= (now() at time zone old.timezone)::date then
    raise exception 'HRMS: only future schedule instances can be refreshed' using errcode = '42501';
  end if;
  return old;
end;
$$;

-- Update existing Saturday snapshots in place. A workday with recorded attendance
-- cannot become a day off. Release leave only on dates that become off.
create function hrms.apply_saturday_schedule(p_org uuid, p_weeks integer, p_actor uuid) returns integer
language plpgsql
set search_path = ''
set hrms.saturday_schedule_update = 'on'
as $$
declare
  v_today date := hrms.org_today(p_org);
  v_slot record;
  v_reconciled integer := 0;
begin
  for v_slot in
    with changed as (
      update hrms.work_schedule_instances w
      set kind = case when hrms.is_saturday_off(w.shift_date, p_weeks) then 'weekly_off' else 'workday' end,
          is_required = not hrms.is_saturday_off(w.shift_date, p_weeks)
      where w.org_id = p_org and w.shift_date >= v_today
        and w.shift_date >= (now() at time zone w.timezone)::date
        and extract(isodow from w.shift_date) = 6
        and w.kind in ('workday', 'weekly_off')
        and w.is_required = hrms.is_saturday_off(w.shift_date, p_weeks)
        and (not w.is_required or (
          not exists (select 1 from hrms.attendance_sessions s where s.schedule_instance_id = w.id)
          and not exists (
            select 1 from hrms.device_attendance_days d
            where d.org_id = p_org and d.employee_id = w.employee_id and d.local_date = w.shift_date
              and coalesce(d.corrected_in_at, d.first_in_at) is not null
          )
          and not exists (
            select 1 from hrms.outside_work ow
            where ow.employee_id = w.employee_id and ow.work_date = w.shift_date and ow.revoked_at is null
              and ow.kind in ('wfh', 'outside') and w.start_at <= now()
          )
        ))
      returning w.employee_id, w.shift_date, w.is_required
    )
    select s.*
    from changed w
    join hrms.leave_day_slots s on s.employee_id = w.employee_id and s.day = w.shift_date
    where not w.is_required and s.state in ('reserved', 'approved')
    order by s.request_id, s.day, s.id
  loop
    if v_slot.state = 'reserved' then
      update hrms.leave_reservations set state = 'released', released_at = now()
      where request_id = v_slot.request_id and day = v_slot.day and state = 'active';
    else
      insert into hrms.leave_ledger (org_id, account_id, allocation_id, entry_kind, units, source_operation_id,
                                     request_id, created_by)
      select v_slot.org_id, lr.account_id, lr.allocation_id, 'credit_back', sum(lr.units)::integer,
             md5(v_slot.request_id::text || ':weekly_off:' || v_slot.day::text)::uuid, v_slot.request_id,
             p_actor
      from hrms.leave_reservations lr
      where lr.request_id = v_slot.request_id and lr.day = v_slot.day and lr.state = 'converted'
      group by lr.account_id, lr.allocation_id
      on conflict (account_id, source_operation_id, entry_kind, allocation_id) do nothing;
      update hrms.leave_reservations set state = 'credited'
      where request_id = v_slot.request_id and day = v_slot.day and state = 'converted';
    end if;
    update hrms.leave_day_slots set state = 'released', released_at = now() where id = v_slot.id;
    update hrms.requests set units = greatest(0, units - case when v_slot.slot = 'FULL' then 2 else 1 end),
                             version = version + 1
    where id = v_slot.request_id;
    insert into hrms.approval_events (org_id, request_id, action, actor_id, reason)
    values (v_slot.org_id, v_slot.request_id, 'holiday_reconciled', p_actor,
            format('%s became a weekly off; leave for that day was released.', v_slot.day));
    perform hrms.notify(v_slot.org_id, v_slot.employee_id, 'leave.holiday_reconciled', 'Leave balance adjusted',
      'A Saturday in your leave is now a weekly off. Your balance was updated.', '/requests/' || v_slot.request_id,
      null, md5(v_slot.id::text || ':weekly_off')::uuid);
    v_reconciled := v_reconciled + 1;
  end loop;
  return v_reconciled;
end;
$$;

create or replace function public.set_saturday_off_weeks(p_weeks integer[]) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_mask integer := 0;
  v_old integer;
  v_week integer;
  v_reconciled integer;
begin
  perform hrms.require_admin(v_actor);
  foreach v_week in array coalesce(p_weeks, '{}'::integer[]) loop
    if v_week is null or v_week not between 1 and 5 then
      perform hrms.raise_error('VALIDATION_FAILED', 'Pick Saturdays 1 to 5.', '{"weeks":"Pick Saturdays 1 to 5"}'::jsonb);
    end if;
    v_mask := v_mask | (1 << (v_week - 1));
  end loop;

  perform pg_advisory_xact_lock(hashtextextended('hrms.saturday_policy:' || v_actor.org_id::text, 0));
  select saturday_off_weeks into v_old from hrms.organizations where id = v_actor.org_id for update;
  if v_old = v_mask then
    return hrms.ok(jsonb_build_object('saturday_off_weeks', v_mask, 'leave_days_reconciled', 0));
  end if;
  update hrms.organizations set saturday_off_weeks = v_mask, version = version + 1 where id = v_actor.org_id;

  v_reconciled := hrms.apply_saturday_schedule(v_actor.org_id, v_mask, v_actor.employee_id);

  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'org.saturday_off_changed', 'organization', v_actor.org_id,
    jsonb_build_object('from', v_old, 'to', v_mask, 'leave_days_reconciled', v_reconciled));
  return hrms.ok(jsonb_build_object('saturday_off_weeks', v_mask, 'leave_days_reconciled', v_reconciled));
end;
$$;

-- Repair Saturdays that were already generated using the old shift mask.
select hrms.apply_saturday_schedule(o.id, o.saturday_off_weeks, null)
from hrms.organizations o;

select hrms.apply_api_grants();
