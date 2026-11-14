-- [web-hrms] Ported from ~/Documents/Projects/november/fingertipssl/supabase/migrations/20261112100000_attendance_rules.sql
-- [web-hrms]   unchanged

-- =============================================================================
-- Attendance day rules. MOVES INTO THE HRMS (after the device migrations).
--
-- Raw device punches stay append-only and remain the source of truth. On top
-- of them, per person per local day:
--   * A scan within the duplicate window (default 10 min, per organisation) of
--     the previous COUNTED scan is a duplicate: kept, never counted. This is
--     what "you cannot check out within 10 minutes" means.
--   * First counted scan = IN. Last counted scan (2nd or later) = OUT. Counted
--     scans in between (e.g. lunch) are "extra" and shown only in the details.
--   * A finished day with only an IN is closed by a scheduled job: an automatic
--     OUT at 23:59:59 local, tagged "forgot to checkout", worked time unknown.
--   * A real OUT that uploads late replaces the automatic one.
--   * HR/Admin may set the OUT time with a reason (audited); that wins over both.
-- Day rows (hrms.device_attendance_days) are derived and recomputed by
-- hrms.device_resequence on every change, so they can always be rebuilt.
-- =============================================================================

create table hrms.device_attendance_settings (
  org_id uuid primary key references hrms.organizations(id) on delete restrict,
  duplicate_window_minutes integer not null default 10 check (duplicate_window_minutes between 1 and 60),
  auto_checkout_enabled boolean not null default true,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- in | out | extra | duplicate. Derived (like action_effective/counted), so the
-- append-only guard leaves it writable.
alter table hrms.device_punch_events add column scan_kind text not null default 'in'
  check (scan_kind in ('in', 'out', 'extra', 'duplicate'));

create table hrms.device_attendance_days (
  org_id uuid not null references hrms.organizations(id) on delete restrict,
  employee_id uuid not null,
  local_date date not null,
  -- From the punches
  first_in_at timestamptz,
  first_in_punch_id uuid references hrms.device_punch_events(id) on delete restrict,
  device_out_at timestamptz,
  device_out_punch_id uuid references hrms.device_punch_events(id) on delete restrict,
  scan_count integer not null default 0,        -- counted scans
  duplicate_count integer not null default 0,
  extra_count integer not null default 0,
  -- Inputs that are not punches
  auto_closed_at timestamptz,                   -- set by the scheduled job
  corrected_out_at timestamptz,
  correction_reason text check (char_length(correction_reason) between 3 and 300),
  corrected_by uuid,
  corrected_at timestamptz,
  -- Result (precedence: HR correction > device OUT > automatic OUT)
  out_at timestamptz,
  out_source text check (out_source in ('device', 'auto', 'hr')),
  forgot_checkout boolean not null default false,
  worked_minutes integer,                       -- null when the OUT is automatic
  updated_at timestamptz not null default now(),
  primary key (org_id, employee_id, local_date),
  foreign key (org_id, employee_id) references hrms.employees(org_id, id) on delete restrict
);
create index device_attendance_days_date_idx on hrms.device_attendance_days (org_id, local_date);
create index device_attendance_days_open_idx on hrms.device_attendance_days (local_date)
  where scan_count = 1 and auto_closed_at is null and corrected_out_at is null;

create or replace function hrms.device_duplicate_window(p_org uuid) returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((select duplicate_window_minutes from hrms.device_attendance_settings where org_id = p_org), 10);
$$;

-- -----------------------------------------------------------------------------
-- Day row: recomputed from the punches + the non-punch inputs on the row
-- -----------------------------------------------------------------------------

create or replace function hrms.device_refresh_day(p_org uuid, p_employee uuid, p_day date) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_tz text;
  v_counted integer;
  v_dups integer;
  v_first_id uuid;
  v_first_at timestamptz;
  v_last_id uuid;
  v_last_at timestamptz;
  v_row hrms.device_attendance_days;
  v_out timestamptz;
  v_src text;
  v_worked integer;
begin
  select timezone into v_tz from hrms.organizations where id = p_org;

  select count(*) filter (where counted), count(*) filter (where not counted)
    into v_counted, v_dups
  from hrms.device_punch_events
  where org_id = p_org and employee_id = p_employee
    and device_local_time >= p_day::timestamp and device_local_time < (p_day + 1)::timestamp;

  select * into v_row from hrms.device_attendance_days
  where org_id = p_org and employee_id = p_employee and local_date = p_day
  for update;

  if v_counted = 0 then
    -- Matched punches never move to someone else, so this only happens for a
    -- day that never had any; nothing to store.
    return;
  end if;

  select id, device_time into v_first_id, v_first_at
  from hrms.device_punch_events
  where org_id = p_org and employee_id = p_employee and counted
    and device_local_time >= p_day::timestamp and device_local_time < (p_day + 1)::timestamp
  order by device_time, id
  limit 1;

  if v_counted >= 2 then
    select id, device_time into v_last_id, v_last_at
    from hrms.device_punch_events
    where org_id = p_org and employee_id = p_employee and counted
      and device_local_time >= p_day::timestamp and device_local_time < (p_day + 1)::timestamp
    order by device_time desc, id desc
    limit 1;
  end if;

  if v_row.corrected_out_at is not null then
    v_out := v_row.corrected_out_at;
    v_src := 'hr';
  elsif v_counted >= 2 then
    v_out := v_last_at;
    v_src := 'device';
  elsif v_row.auto_closed_at is not null then
    v_out := (p_day + time '23:59:59') at time zone v_tz;
    v_src := 'auto';
  else
    v_out := null;
    v_src := null;
  end if;
  v_worked := case when v_src in ('device', 'hr')
                   then greatest(0, floor(extract(epoch from (v_out - v_first_at)) / 60))::integer end;

  insert into hrms.device_attendance_days as d (
    org_id, employee_id, local_date, first_in_at, first_in_punch_id, device_out_at, device_out_punch_id,
    scan_count, duplicate_count, extra_count, out_at, out_source, forgot_checkout, worked_minutes, updated_at
  ) values (
    p_org, p_employee, p_day, v_first_at, v_first_id, v_last_at, v_last_id,
    v_counted, v_dups, greatest(v_counted - 2, 0), v_out, v_src,
    v_counted = 1 and v_row.auto_closed_at is not null, v_worked, now()
  )
  on conflict (org_id, employee_id, local_date) do update set
    first_in_at = excluded.first_in_at,
    first_in_punch_id = excluded.first_in_punch_id,
    device_out_at = excluded.device_out_at,
    device_out_punch_id = excluded.device_out_punch_id,
    scan_count = excluded.scan_count,
    duplicate_count = excluded.duplicate_count,
    extra_count = excluded.extra_count,
    out_at = excluded.out_at,
    out_source = excluded.out_source,
    forgot_checkout = excluded.forgot_checkout,
    worked_minutes = excluded.worked_minutes,
    updated_at = now()
  where (d.first_in_at, d.first_in_punch_id, d.device_out_at, d.device_out_punch_id, d.scan_count,
         d.duplicate_count, d.extra_count, d.out_at, d.out_source, d.forgot_checkout, d.worked_minutes)
        is distinct from
        (excluded.first_in_at, excluded.first_in_punch_id, excluded.device_out_at, excluded.device_out_punch_id,
         excluded.scan_count, excluded.duplicate_count, excluded.extra_count, excluded.out_at, excluded.out_source,
         excluded.forgot_checkout, excluded.worked_minutes);
end;
$$;

-- -----------------------------------------------------------------------------
-- Per-punch labels (replaces the 60 s / alternating version)
-- -----------------------------------------------------------------------------

-- Recomputes scan_kind / counted / action_effective for one person's punches
-- on one local day (an employee's when p_employee is set, else the unmatched
-- punches of p_pin), then that employee's day row. Writes only on change.
create or replace function hrms.device_resequence(p_org uuid, p_employee uuid, p_pin text, p_day date)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_window interval := make_interval(mins => hrms.device_duplicate_window(p_org));
  v_ids uuid[];
  v_times timestamptz[];
  v_n integer;
  v_counted boolean[];
  v_ord integer[];
  v_c integer := 0;
  v_anchor timestamptz;
  v_last_i integer;
  v_kind text;
  v_action text;
  v_prev_action text := 'IN';
begin
  select array_agg(id order by device_time, id), array_agg(device_time order by device_time, id)
    into v_ids, v_times
  from hrms.device_punch_events
  where org_id = p_org
    and device_local_time >= p_day::timestamp
    and device_local_time < (p_day + 1)::timestamp
    and case when p_employee is not null then employee_id = p_employee
             else employee_id is null and pin = p_pin end;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n > 0 then
    v_counted := array_fill(false, array[v_n]);
    v_ord := array_fill(0, array[v_n]);
    for i in 1 .. v_n loop
      if v_anchor is null or v_times[i] - v_anchor >= v_window then
        v_c := v_c + 1;
        v_counted[i] := true;
        v_ord[i] := v_c;
        v_anchor := v_times[i];
        v_last_i := i;
      end if;
    end loop;

    for i in 1 .. v_n loop
      if v_counted[i] then
        if v_ord[i] = 1 then
          v_kind := 'in';
          v_action := 'IN';
        elsif i = v_last_i then
          v_kind := 'out';
          v_action := 'OUT';
        else
          v_kind := 'extra';
          v_action := case when v_ord[i] % 2 = 1 then 'IN' else 'OUT' end;
        end if;
        v_prev_action := v_action;
      else
        v_kind := 'duplicate';
        v_action := v_prev_action;
      end if;
      update hrms.device_punch_events
         set scan_kind = v_kind, action_effective = v_action, counted = v_counted[i]
       where id = v_ids[i]
         and (scan_kind, action_effective, counted) is distinct from (v_kind, v_action, v_counted[i]);
    end loop;
  end if;

  if p_employee is not null then
    perform hrms.device_refresh_day(p_org, p_employee, p_day);
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Scheduled close: finished days that only have an IN get the automatic OUT
-- -----------------------------------------------------------------------------

-- Runs every 5 minutes (pg_cron below). Closing "any finished day" instead of
-- firing once at midnight means a stopped database catches up when it is back.
create or replace function hrms.device_close_days() returns integer
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select d.org_id, d.employee_id, d.local_date
    from hrms.device_attendance_days d
    join hrms.organizations o on o.id = d.org_id
    left join hrms.device_attendance_settings s on s.org_id = d.org_id
    where d.scan_count = 1 and d.auto_closed_at is null and d.corrected_out_at is null
      and coalesce(s.auto_checkout_enabled, true)
      and d.local_date < (now() at time zone o.timezone)::date
    order by d.org_id, d.local_date
  loop
    perform hrms.device_lock_org(r.org_id);
    update hrms.device_attendance_days set auto_closed_at = now()
     where org_id = r.org_id and employee_id = r.employee_id and local_date = r.local_date
       and auto_closed_at is null and scan_count = 1 and corrected_out_at is null;
    if found then
      perform hrms.device_refresh_day(r.org_id, r.employee_id, r.local_date);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Live board: day-row changes are broadcast on the same private topic
-- -----------------------------------------------------------------------------

create or replace function hrms.device_day_broadcast() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send(
      jsonb_build_object('employee_id', new.employee_id, 'local_date', new.local_date, 'op', tg_op),
      'day',
      'hrms:device-punches:' || new.org_id::text,
      true
    );
  end if;
  return null;
exception when others then
  return null;
end;
$$;
create trigger device_attendance_days_broadcast after insert or update on hrms.device_attendance_days
  for each row execute function hrms.device_day_broadcast();

-- -----------------------------------------------------------------------------
-- Dashboard RPCs (HR/Admin)
-- -----------------------------------------------------------------------------

create or replace function hrms.device_settings_json(p_org uuid) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'duplicate_window_minutes', coalesce(s.duplicate_window_minutes, 10),
    'auto_checkout_enabled', coalesce(s.auto_checkout_enabled, true),
    'timezone', o.timezone,
    'today', to_char((now() at time zone o.timezone)::date, 'YYYY-MM-DD'),
    'updated_at', s.updated_at
  )
  from hrms.organizations o
  left join hrms.device_attendance_settings s on s.org_id = o.id
  where o.id = p_org;
$$;

create or replace function public.get_attendance_settings() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
begin
  return hrms.ok(hrms.device_settings_json(v_actor.org_id));
end;
$$;

-- p: {duplicate_window_minutes?, auto_checkout_enabled?}. Admin only. A new
-- window applies from today: today's punches are re-labelled, past days keep
-- the window they were recorded under.
create or replace function public.save_attendance_settings(p jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_old jsonb;
  v_window integer;
  v_auto boolean;
  v_tz text;
  v_today date;
  r record;
begin
  if not ('admin' = any(v_actor.roles)) then
    perform hrms.raise_error('ACCESS_DENIED', 'Only an Admin can change the attendance rules.');
  end if;
  v_old := hrms.device_settings_json(v_actor.org_id);
  begin
    v_window := coalesce((p ->> 'duplicate_window_minutes')::integer, (v_old ->> 'duplicate_window_minutes')::integer);
    v_auto := coalesce((p ->> 'auto_checkout_enabled')::boolean, (v_old ->> 'auto_checkout_enabled')::boolean);
  exception when others then
    perform hrms.raise_error('VALIDATION_FAILED', 'Invalid settings.');
  end;
  if v_window not between 1 and 60 then
    perform hrms.raise_error('VALIDATION_FAILED', 'The duplicate window must be 1–60 minutes.',
                             jsonb_build_object('duplicate_window_minutes', 'out_of_range'));
  end if;

  perform hrms.device_lock_org(v_actor.org_id);
  insert into hrms.device_attendance_settings (org_id, duplicate_window_minutes, auto_checkout_enabled, updated_by, updated_at)
  values (v_actor.org_id, v_window, v_auto, v_actor.employee_id, now())
  on conflict (org_id) do update set
    duplicate_window_minutes = excluded.duplicate_window_minutes,
    auto_checkout_enabled = excluded.auto_checkout_enabled,
    updated_by = excluded.updated_by,
    updated_at = now();

  if v_window <> (v_old ->> 'duplicate_window_minutes')::integer then
    select timezone into v_tz from hrms.organizations where id = v_actor.org_id;
    v_today := (now() at time zone v_tz)::date;
    for r in
      select distinct employee_id, case when employee_id is null then pin end as pin
      from hrms.device_punch_events
      where org_id = v_actor.org_id and device_local_time >= v_today::timestamp
    loop
      perform hrms.device_resequence(v_actor.org_id, r.employee_id, r.pin, v_today);
    end loop;
  end if;

  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'attendance.settings', 'organization', v_actor.org_id,
    jsonb_build_object('duplicate_window_minutes', jsonb_build_array(v_old -> 'duplicate_window_minutes', v_window),
                       'auto_checkout_enabled', jsonb_build_array(v_old -> 'auto_checkout_enabled', v_auto)),
    'business');
  return hrms.ok(hrms.device_settings_json(v_actor.org_id));
end;
$$;

-- One row per active employee (plus anyone with a record that day).
-- status: not_in (today, no scan) | absent (past, no scan) | in_office (today,
-- IN only) | checked_out | forgot_checkout | no_checkout (past, IN only, not
-- auto-closed) | corrected (HR set the OUT).
create or replace function public.list_attendance_day(p_date text default null) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_tz text;
  v_today date;
  v_date date;
  v_rows jsonb;
begin
  select timezone into v_tz from hrms.organizations where id = v_actor.org_id;
  v_today := (now() at time zone v_tz)::date;
  begin
    v_date := coalesce(nullif(btrim(coalesce(p_date, '')), '')::date, v_today);
  exception when others then
    perform hrms.raise_error('VALIDATION_FAILED', 'Invalid date.', jsonb_build_object('date', 'invalid'));
  end;
  if v_date > v_today then
    perform hrms.raise_error('VALIDATION_FAILED', 'That date has not happened yet.', jsonb_build_object('date', 'future'));
  end if;

  select coalesce(jsonb_agg(row_json order by sort_status, name), '[]'::jsonb) into v_rows
  from (
    select e.full_name as name,
      case
        when d.employee_id is null then 3
        when d.out_source = 'auto' or (d.out_source is null and v_date < v_today) then 0
        when d.out_source is null then 1
        else 2 end as sort_status,
      jsonb_build_object(
        'employee', jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name, 'status', e.status),
        'pins', (select coalesce(jsonb_agg(l.pin order by l.pin), '[]'::jsonb) from hrms.device_user_links l
                 where l.employee_id = e.id and l.unlinked_at is null),
        'status', case
          when d.employee_id is null then case when v_date = v_today then 'not_in' else 'absent' end
          when d.out_source = 'hr' then 'corrected'
          when d.out_source = 'device' then 'checked_out'
          when d.out_source = 'auto' then 'forgot_checkout'
          when v_date = v_today then 'in_office'
          else 'no_checkout' end,
        'first_in_at', d.first_in_at,
        'out_at', d.out_at,
        'out_source', d.out_source,
        'device_out_at', d.device_out_at,
        'forgot_checkout', coalesce(d.forgot_checkout, false),
        'worked_minutes', d.worked_minutes,
        'scan_count', coalesce(d.scan_count, 0),
        'duplicate_count', coalesce(d.duplicate_count, 0),
        'extra_count', coalesce(d.extra_count, 0),
        'correction', case when d.corrected_out_at is not null then jsonb_build_object(
          'out_at', d.corrected_out_at, 'reason', d.correction_reason, 'at', d.corrected_at,
          'by', (select full_name from hrms.employees c where c.id = d.corrected_by)) end
      ) as row_json
    from hrms.employees e
    left join hrms.device_attendance_days d
      on d.org_id = e.org_id and d.employee_id = e.id and d.local_date = v_date
    where e.org_id = v_actor.org_id
      and (e.status = 'active' or d.employee_id is not null)
  ) s;

  return hrms.ok(jsonb_build_object(
    'date', to_char(v_date, 'YYYY-MM-DD'),
    'is_today', v_date = v_today,
    'settings', hrms.device_settings_json(v_actor.org_id),
    'rows', v_rows
  ));
end;
$$;

-- HR/Admin sets (or, with p_out_time null/'', clears) the OUT time of a day
-- that has an IN. p_out_time is local 'HH:MM' on p_date. Raw punches are
-- never touched; the correction is audited with the reason.
create or replace function public.correct_attendance_day(
  p_employee_id uuid, p_date text, p_out_time text, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_tz text;
  v_date date;
  v_time time;
  v_out timestamptz;
  v_reason text := hrms.clean_text(p_reason, 300);
  v_row hrms.device_attendance_days;
  v_new hrms.device_attendance_days;
begin
  select timezone into v_tz from hrms.organizations where id = v_actor.org_id;
  begin
    v_date := btrim(p_date)::date;
    v_time := nullif(btrim(coalesce(p_out_time, '')), '')::time;
  exception when others then
    perform hrms.raise_error('VALIDATION_FAILED', 'Invalid date or time.');
  end;
  if v_reason is null or char_length(v_reason) < 3 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Give a reason (at least 3 characters).', jsonb_build_object('reason', 'required'));
  end if;

  perform hrms.device_lock_org(v_actor.org_id);
  select * into v_row from hrms.device_attendance_days
  where org_id = v_actor.org_id and employee_id = p_employee_id and local_date = v_date
  for update;
  if v_row.employee_id is null or v_row.first_in_at is null then
    perform hrms.raise_error('NOT_FOUND', 'There is no check-in for that person on that day.');
  end if;

  if v_time is not null then
    v_out := (v_date + v_time) at time zone v_tz;
    if v_out <= v_row.first_in_at then
      perform hrms.raise_error('VALIDATION_FAILED', 'The check-out must be after the check-in.', jsonb_build_object('out_time', 'before_in'));
    end if;
    if v_out > now() + interval '1 minute' then
      perform hrms.raise_error('VALIDATION_FAILED', 'The check-out cannot be in the future.', jsonb_build_object('out_time', 'future'));
    end if;
  elsif v_row.corrected_out_at is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'Enter the check-out time.', jsonb_build_object('out_time', 'required'));
  end if;

  update hrms.device_attendance_days set
    corrected_out_at = v_out,
    correction_reason = case when v_out is null then null else v_reason end,
    corrected_by = case when v_out is null then null else v_actor.employee_id end,
    corrected_at = case when v_out is null then null else now() end
  where org_id = v_actor.org_id and employee_id = p_employee_id and local_date = v_date;
  perform hrms.device_refresh_day(v_actor.org_id, p_employee_id, v_date);
  select * into v_new from hrms.device_attendance_days
  where org_id = v_actor.org_id and employee_id = p_employee_id and local_date = v_date;

  perform hrms.audit(v_actor.org_id, v_actor.employee_id,
    case when v_out is null then 'attendance_day.correction_cleared' else 'attendance_day.correct' end,
    'employee', p_employee_id,
    jsonb_build_object('date', v_date, 'out_at', jsonb_build_array(v_row.out_at, v_new.out_at),
                       'out_source', jsonb_build_array(v_row.out_source, v_new.out_source), 'reason', v_reason),
    'business', p_employee_id);

  return hrms.ok(jsonb_build_object('out_at', v_new.out_at, 'out_source', v_new.out_source,
                                    'worked_minutes', v_new.worked_minutes));
end;
$$;

-- Punch feed gains the scan label (otherwise identical to the original).
create or replace function public.list_device_punches(p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_hr boolean := hrms.is_hr_or_admin(v_actor);
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_ids uuid[];
  v_emp uuid;
  v_serial text;
  v_unmatched boolean;
  v_from date;
  v_to date;
  v_limit integer;
  v_before_at timestamptz;
  v_before_id uuid;
begin
  begin
    if jsonb_typeof(f -> 'ids') = 'array' then
      select array_agg(x::uuid) into v_ids from (select jsonb_array_elements_text(f -> 'ids') x limit 100) s;
    end if;
    v_emp := nullif(f ->> 'employee_id', '')::uuid;
    v_serial := nullif(btrim(f ->> 'serial'), '');
    v_unmatched := coalesce((f ->> 'unmatched')::boolean, false);
    v_from := nullif(f ->> 'from', '')::date;
    v_to := nullif(f ->> 'to', '')::date;
    v_limit := least(greatest(coalesce((f ->> 'limit')::integer, 50), 1), 200);
    v_before_at := nullif(f ->> 'before_received_at', '')::timestamptz;
    v_before_id := nullif(f ->> 'before_id', '')::uuid;
  exception when others then
    perform hrms.raise_error('VALIDATION_FAILED', 'Invalid filter.');
  end;

  return hrms.ok(coalesce((
    select jsonb_agg(row_json order by received_at desc, id desc)
    from (
      select p.received_at, p.id, jsonb_build_object(
        'id', p.id,
        'source', p.source,
        'serial', p.serial,
        'device_label', d.label,
        'pin', case when v_hr then p.pin end,
        'employee', case when e.id is not null then
          jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name) end,
        'action', p.action_effective,
        'kind', p.scan_kind,
        'counted', p.counted,
        'device_time', p.device_time,
        'device_local_time', to_char(p.device_local_time, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'received_at', p.received_at,
        'verify_mode', p.verify_mode,
        'has_photo', v_hr and p.photo_path is not null,
        'integrity', case when v_hr then p.integrity end
      ) as row_json
      from hrms.device_punch_events p
      left join hrms.employees e on e.id = p.employee_id
      left join hrms.attendance_devices d on d.serial = p.serial
      where p.org_id = v_actor.org_id
        and (v_hr or p.employee_id = v_actor.employee_id)
        and (v_ids is null or p.id = any(v_ids))
        and (v_emp is null or p.employee_id = v_emp)
        and (v_serial is null or p.serial = v_serial)
        and (not v_unmatched or (v_hr and p.employee_id is null))
        and (v_from is null or p.device_local_time >= v_from::timestamp)
        and (v_to is null or p.device_local_time < (v_to + 1)::timestamp)
        and (v_before_at is null or (p.received_at, p.id) < (v_before_at, coalesce(v_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
      order by p.received_at desc, p.id desc
      limit v_limit
    ) s
  ), '[]'::jsonb));
end;
$$;

-- -----------------------------------------------------------------------------
-- Backfill existing punches under the new rules, then close finished days
-- -----------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in
    select distinct org_id, employee_id, case when employee_id is null then pin end as pin,
           device_local_time::date as day
    from hrms.device_punch_events
  loop
    perform hrms.device_resequence(r.org_id, r.employee_id, r.pin, r.day);
  end loop;
  perform hrms.device_close_days();
end $$;

-- -----------------------------------------------------------------------------
-- Schedule (pg_cron). Idempotent: re-scheduling by name replaces the job.
-- -----------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('hrms-device-close-attendance-days', '*/5 * * * *', 'select hrms.device_close_days()');
  else
    raise warning 'pg_cron is not available: run select hrms.device_close_days() on a schedule another way.';
  end if;
end $$;

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'hrms' loop
    execute format('alter table hrms.%I enable row level security', r.tablename);
  end loop;
end $$;

select hrms.apply_api_grants();
