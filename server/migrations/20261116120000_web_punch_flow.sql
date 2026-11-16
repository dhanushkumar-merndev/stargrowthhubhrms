-- web-hrms: the punch flow around the attendance machines.
--
-- * Punch in only at the machine: when the organisation has an active
--   attendance machine, the app cannot open a check-in session (trigger on
--   hrms.attendance_sessions). Outdoor work is the exception (below).
-- * A machine punch-in / punch-out is pushed to the person straight away
--   (trigger on hrms.device_attendance_days, only for punches from the last
--   3 hours so a machine uploading its backlog does not flood anyone). The
--   notification opens /attendance/today where they can act on it.
-- * Forgot to punch out: the person sets their punch-out from the app for
--   today or the last 2 days (out_source 'app'). Precedence on the day row:
--   HR correction > machine OUT > app OUT > automatic OUT.
-- * Wrong time: the person asks for a fix (proposed in and/or out time with a
--   reason); HR/Admin approve (applied as an HR correction, including a
--   corrected check-in time) or reject.
-- * Outdoor work: punch in from the app with a reason and a photo (and the
--   location when the browser gives it). It counts at once, as outside work
--   (kind 'outdoor'); HR/Admin, or the person's team leader, can reject it.
--   The photo is a correction_attachment owned by the person; those who can
--   see the person's work can open it.

-- ----------------------------------------------------------------- day row

alter table hrms.device_attendance_days
  add column corrected_in_at timestamptz,
  add column app_out_at timestamptz,
  add column app_out_reason text check (app_out_reason is null or char_length(app_out_reason) between 3 and 300),
  add column app_out_set_at timestamptz;
alter table hrms.device_attendance_days drop constraint device_attendance_days_out_source_check;
alter table hrms.device_attendance_days add constraint device_attendance_days_out_source_check
  check (out_source in ('device', 'auto', 'hr', 'app'));

-- ------------------------------------------------------------ outdoor work

alter table hrms.outside_work drop constraint outside_work_kind_check;
alter table hrms.outside_work add constraint outside_work_kind_check check (kind in ('outside', 'wfh', 'outdoor'));
alter table hrms.outside_work drop constraint outside_work_wfh_has_request;
alter table hrms.outside_work add constraint outside_work_wfh_has_request check (kind <> 'wfh' or request_id is not null);
alter table hrms.outside_work
  add column punch_in_at timestamptz,
  add column punch_out_at timestamptz,
  add column photo_file_version_id uuid,
  add column latitude double precision check (latitude between -90 and 90),
  add column longitude double precision check (longitude between -180 and 180),
  add constraint outside_work_outdoor_shape check (
    kind <> 'outdoor' or (punch_in_at is not null and photo_file_version_id is not null)),
  add constraint outside_work_out_after_in check (punch_out_at is null or punch_out_at > punch_in_at);
create index outside_work_photo on hrms.outside_work (photo_file_version_id) where photo_file_version_id is not null;

-- ------------------------------------------------------------ fix requests

create table hrms.punch_fix_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references hrms.organizations(id) on delete restrict,
  employee_id uuid not null,
  local_date date not null,
  in_at timestamptz,
  out_at timestamptz,
  reason text not null check (char_length(reason) between 5 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  reviewed_by uuid references hrms.employees(id),
  reviewed_at timestamptz,
  review_note text check (review_note is null or char_length(review_note) <= 300),
  created_at timestamptz not null default now(),
  foreign key (org_id, employee_id) references hrms.employees(org_id, id) on delete restrict,
  check (in_at is not null or out_at is not null),
  check (in_at is null or out_at is null or out_at > in_at)
);
create unique index punch_fix_one_pending on hrms.punch_fix_requests (employee_id, local_date) where status = 'pending';
create index punch_fix_org_status on hrms.punch_fix_requests (org_id, status, created_at desc);
alter table hrms.punch_fix_requests enable row level security;

-- ----------------------------------------------------------------- helpers

create or replace function hrms.org_has_machines(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from hrms.attendance_devices d where d.org_id = p_org and d.active);
$$;

-- HR/Admin and the person's team leaders (never the person).
create or replace function hrms.punch_watchers(p_org uuid, p_employee uuid, p_date date) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select e.id from hrms.employees e
  where e.org_id = p_org and e.status = 'active' and e.id <> p_employee
    and (hrms.employee_roles(e.id) && array['hr', 'admin'] or hrms.is_lead_of(e.id, p_employee, p_date));
$$;

create or replace function hrms.fmt_clock(p_at timestamptz, p_tz text) returns text
language sql stable set search_path = '' as $$
  select ltrim(to_char(p_at at time zone p_tz, 'HH12:MI AM'), '0');
$$;

-- "HH:MI" on a local date -> timestamptz, or null for blank; raises on junk.
create or replace function hrms.local_clock(p_date date, p_time text, p_tz text, p_field text) returns timestamptz
language plpgsql stable set search_path = '' as $$
declare v_t time;
begin
  if nullif(btrim(coalesce(p_time, '')), '') is null then return null; end if;
  begin
    v_t := btrim(p_time)::time;
  exception when others then
    perform hrms.raise_error('VALIDATION_FAILED', 'Enter a time like 18:30.', jsonb_build_object(p_field, 'invalid'));
  end;
  return (p_date + v_t) at time zone p_tz;
end;
$$;

create or replace function hrms.parse_day(p_date text, p_today date, p_back integer) returns date
language plpgsql stable set search_path = '' as $$
declare v_d date;
begin
  begin
    v_d := coalesce(nullif(btrim(coalesce(p_date, '')), '')::date, p_today);
  exception when others then
    perform hrms.raise_error('VALIDATION_FAILED', 'Invalid date.', '{"date":"invalid"}'::jsonb);
  end;
  if v_d > p_today then
    perform hrms.raise_error('VALIDATION_FAILED', 'That date has not happened yet.', '{"date":"future"}'::jsonb);
  end if;
  if v_d < p_today - p_back then
    perform hrms.raise_error('VALIDATION_FAILED', 'Pick today or one of the last ' || p_back || ' days.', '{"date":"too_old"}'::jsonb);
  end if;
  return v_d;
end;
$$;

-- --------------------------------------------- punch in only at the machine

create or replace function hrms.app_check_in_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if hrms.org_has_machines(new.org_id) then
    perform hrms.raise_error('VALIDATION_FAILED',
      'Punch in at the attendance machine. Use the app to punch out, or to punch in for outdoor work.',
      '{"action":"punch_in_at_machine"}'::jsonb);
  end if;
  return new;
end;
$$;
create trigger attendance_sessions_machine_only before insert on hrms.attendance_sessions
  for each row execute function hrms.app_check_in_guard();

-- ------------------------------------------------ tell people they punched

create or replace function hrms.device_day_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tz text;
  v_label text;
  v_link text := '/attendance/today?date=' || to_char(new.local_date, 'YYYY-MM-DD');
begin
  if not exists (select 1 from hrms.employees where id = new.employee_id and status = 'active') then
    return null;
  end if;
  select timezone into v_tz from hrms.organizations where id = new.org_id;
  if new.first_in_punch_id is not null and (tg_op = 'INSERT' or old.first_in_punch_id is null)
     and new.first_in_at > now() - interval '3 hours' then
    select d.label into v_label from hrms.device_punch_events p
    join hrms.attendance_devices d on d.serial = p.serial where p.id = new.first_in_punch_id;
    perform hrms.notify(new.org_id, new.employee_id, 'attendance.device_in',
      'You punched in at ' || hrms.fmt_clock(new.first_in_at, v_tz),
      coalesce(v_label || '. ', '') || 'Wrong time? Tap to ask for a fix. Forget to punch out later? Do it from here.',
      v_link, jsonb_build_object('date', new.local_date), md5(new.first_in_punch_id::text || ':device_in')::uuid);
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
create trigger device_attendance_days_notify after insert or update of first_in_punch_id, device_out_punch_id
  on hrms.device_attendance_days for each row execute function hrms.device_day_notify();

-- --------------------------------------------- redefined from earlier files

-- From 20261112100000_attendance_rules.sql, plus the corrected check-in and
-- the app punch-out.
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

  -- An approved fix request moves the check-in (the punch stays the evidence).
  if v_row.corrected_in_at is not null then
    v_first_at := v_row.corrected_in_at;
  end if;

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
  elsif v_row.app_out_at is not null then
    v_out := v_row.app_out_at;
    v_src := 'app';
  elsif v_row.auto_closed_at is not null then
    v_out := (p_day + time '23:59:59') at time zone v_tz;
    v_src := 'auto';
  else
    v_out := null;
    v_src := null;
  end if;
  v_worked := case when v_src in ('device', 'hr', 'app')
                   then greatest(0, floor(extract(epoch from (v_out - v_first_at)) / 60))::integer end;

  insert into hrms.device_attendance_days as d (
    org_id, employee_id, local_date, first_in_at, first_in_punch_id, device_out_at, device_out_punch_id,
    scan_count, duplicate_count, extra_count, out_at, out_source, forgot_checkout, worked_minutes, updated_at
  ) values (
    p_org, p_employee, p_day, v_first_at, v_first_id, v_last_at, v_last_id,
    v_counted, v_dups, greatest(v_counted - 2, 0), v_out, v_src,
    v_counted = 1 and v_row.auto_closed_at is not null and v_row.app_out_at is null, v_worked, now()
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

-- From 20261112100000_attendance_rules.sql, plus app punch-outs and outdoor
-- punch-ins.
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
        when d.employee_id is null and ow.id is not null then 2
        when d.employee_id is null then 3
        when d.out_source = 'auto' or (d.out_source is null and v_date < v_today) then 0
        when d.out_source is null then 1
        else 2 end as sort_status,
      jsonb_build_object(
        'employee', jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name, 'status', e.status),
        'pins', (select coalesce(jsonb_agg(l.pin order by l.pin), '[]'::jsonb) from hrms.device_user_links l
                 where l.employee_id = e.id and l.unlinked_at is null),
        'status', case
          when d.employee_id is null and ow.id is not null then 'outdoor'
          when d.employee_id is null then case when v_date = v_today then 'not_in' else 'absent' end
          when d.out_source = 'hr' then 'corrected'
          when d.out_source = 'device' then 'checked_out'
          when d.out_source = 'app' then 'app_checkout'
          when d.out_source = 'auto' then 'forgot_checkout'
          when v_date = v_today then 'in_office'
          else 'no_checkout' end,
        'first_in_at', d.first_in_at,
        'out_at', d.out_at,
        'out_source', d.out_source,
        'app_out_reason', d.app_out_reason,
        'outdoor', case when ow.id is not null then jsonb_build_object(
          'id', ow.id, 'reason', ow.reason, 'punch_in_at', ow.punch_in_at, 'punch_out_at', ow.punch_out_at,
          'photo_file_version_id', ow.photo_file_version_id) end,
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
    left join hrms.outside_work ow
      on ow.employee_id = e.id and ow.work_date = v_date and ow.kind = 'outdoor' and ow.revoked_at is null
    where e.org_id = v_actor.org_id
      and (e.status = 'active' or d.employee_id is not null or ow.id is not null)
  ) s;

  return hrms.ok(jsonb_build_object(
    'date', to_char(v_date, 'YYYY-MM-DD'),
    'is_today', v_date = v_today,
    'settings', hrms.device_settings_json(v_actor.org_id),
    'rows', v_rows
  ));
end;
$$;

-- From 20260930100000_archive.sql, plus outdoor punch-in photos.
create or replace function public.internal_authorize_file_access(
  p_auth_user_id uuid, p_session_id uuid, p_email text, p_file_version_id uuid, p_purpose text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.resolve_actor(p_auth_user_id, p_session_id, p_email, 'business');
  v_ver hrms.file_versions;
  v_rec hrms.file_records;
  v_slip hrms.payslips;
  v_ok boolean := false;
  v_grant uuid;
  v_req hrms.requests;
  v_gone boolean;
begin
  if p_purpose not in ('view', 'download', 'review') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown purpose');
  end if;
  select * into v_ver from hrms.file_versions where id = p_file_version_id;
  if not found or v_ver.org_id <> v_actor.org_id then perform hrms.raise_error('ACCESS_DENIED'); end if;
  select * into v_rec from hrms.file_records where id = v_ver.file_record_id;
  v_gone := v_ver.state in ('deleted', 'deletion_pending', 'archived');

  if v_rec.class = 'payslip' then
    if hrms.can_manage_payroll(v_actor) then
      v_ok := v_ver.state in ('validated', 'published', 'superseded') or v_gone;
    elsif v_rec.owner_employee_id = v_actor.employee_id then
      select * into v_slip from hrms.payslips where file_record_id = v_rec.id;
      -- Member window: by salary month (business period), never upload date.
      v_ok := (v_ver.state = 'published' or v_gone) and v_slip.current_file_version_id = v_ver.id
              and v_slip.salary_month >= hrms.payslip_window_start(v_actor.org_id)
              and v_slip.salary_month <= date_trunc('month', hrms.org_today(v_actor.org_id))::date;
    end if;
  elsif v_rec.class = 'avatar' then
    v_ok := v_ver.state = 'published';
  elsif v_rec.class = 'company_policy' then
    v_ok := v_ver.state = 'published' or hrms.is_admin(v_actor) or hrms.has_perm(v_actor, 'policy.draft');
  elsif v_rec.class = 'employee_document' then
    v_ok := (v_ver.state in ('validated', 'published') or v_gone) and (
              v_rec.owner_employee_id = v_actor.employee_id
              or hrms.has_perm(v_actor, 'hr.employees.view'));
  else
    -- Request attachments: owner, or the reviewer through the CURRENT review
    -- lock of the revision that references this file. Medical attachments
    -- additionally need the documents.medical grant (or Admin).
    if v_rec.owner_employee_id = v_actor.employee_id then
      v_ok := v_ver.state in ('validated', 'published');
    elsif exists (select 1 from hrms.outside_work ow
                  where ow.photo_file_version_id = v_ver.id and ow.org_id = v_actor.org_id
                    and ow.employee_id = v_rec.owner_employee_id
                    and hrms.can_see_work(v_actor, ow.employee_id)) then
      v_ok := v_ver.state in ('validated', 'published');
    else
      select r.* into v_req from hrms.requests r
      join hrms.request_revisions rv on rv.request_id = r.id and rv.revision_no = r.current_revision
      where r.employee_id = v_rec.owner_employee_id
        and rv.payload ->> 'attachment_file_version_id' = v_ver.id::text
        and r.state in ('under_review', 'approved', 'rejected', 'withdrawal_pending', 'cancellation_pending')
        and r.locked_revision = r.current_revision
      limit 1;
      v_ok := v_req.id is not null and hrms.review_authority(v_actor, v_req) is not null
              and (v_rec.class <> 'medical_attachment' or hrms.is_admin(v_actor)
                   or hrms.has_perm(v_actor, 'documents.medical'));
    end if;
  end if;

  if not v_ok then
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'file.access_denied', 'file_version', v_ver.id,
      jsonb_build_object('class', v_rec.class, 'purpose', p_purpose), 'access', v_rec.owner_employee_id);
    perform hrms.raise_error('ACCESS_DENIED');
  end if;

  if v_gone or v_ver.object_key is null then
    return jsonb_build_object('available', false, 'reason', 'archived',
      'message', 'This file was archived locally. Contact HR for a copy.');
  end if;

  insert into hrms.file_access_grants (org_id, actor_id, file_version_id, purpose, link_ttl_seconds)
  values (v_actor.org_id, v_actor.employee_id, v_ver.id, p_purpose, 60)
  returning id into v_grant;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'file.access_granted', 'file_version', v_ver.id,
    jsonb_build_object('class', v_rec.class, 'purpose', p_purpose, 'grant_id', v_grant), 'access',
    v_rec.owner_employee_id);
  return jsonb_build_object('available', true, 'grant_id', v_grant, 'bucket', 'hrms-files',
    'object_key', v_ver.object_key, 'ttl_seconds', 60, 'mime', coalesce(v_ver.detected_mime, v_ver.declared_mime),
    'filename', v_ver.original_filename, 'size_bytes', v_ver.size_bytes);
end;
$$;

-- ------------------------------------------------------------ the person

create or replace function hrms.outdoor_json(p_ow hrms.outside_work, p_actor hrms.actor) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p_ow.id, 'work_date', p_ow.work_date, 'reason', p_ow.reason,
    'punch_in_at', p_ow.punch_in_at, 'punch_out_at', p_ow.punch_out_at,
    'photo_file_version_id', p_ow.photo_file_version_id,
    'latitude', p_ow.latitude, 'longitude', p_ow.longitude,
    'status', case when p_ow.revoked_at is null then 'counted' else 'rejected' end,
    'rejected_at', p_ow.revoked_at, 'reject_reason', p_ow.revoke_reason,
    'rejected_by', (select full_name from hrms.employees where id = p_ow.revoked_by),
    'employee', (select jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name)
                 from hrms.employees e where e.id = p_ow.employee_id),
    'can_reject', p_ow.revoked_at is null and p_ow.employee_id <> p_actor.employee_id
                  and hrms.can_see_work(p_actor, p_ow.employee_id));
$$;

create or replace function hrms.fix_json(p_r hrms.punch_fix_requests, p_actor hrms.actor) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p_r.id, 'date', p_r.local_date, 'in_at', p_r.in_at, 'out_at', p_r.out_at, 'reason', p_r.reason,
    'status', p_r.status, 'created_at', p_r.created_at, 'reviewed_at', p_r.reviewed_at, 'review_note', p_r.review_note,
    'reviewed_by', (select full_name from hrms.employees where id = p_r.reviewed_by),
    'employee', (select jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name)
                 from hrms.employees e where e.id = p_r.employee_id),
    'day', (select jsonb_build_object('first_in_at', d.first_in_at, 'out_at', d.out_at, 'out_source', d.out_source)
            from hrms.device_attendance_days d
            where d.org_id = p_r.org_id and d.employee_id = p_r.employee_id and d.local_date = p_r.local_date),
    'can_review', p_r.status = 'pending' and p_r.employee_id <> p_actor.employee_id and hrms.is_hr_or_admin(p_actor),
    'can_withdraw', p_r.status = 'pending' and p_r.employee_id = p_actor.employee_id);
$$;

create or replace function public.get_my_punch_day(p_date text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_tz text;
  v_today date := hrms.org_today(v_actor.org_id);
  v_date date := hrms.parse_day(p_date, v_today, 31);
  v_d hrms.device_attendance_days;
  v_ow hrms.outside_work;
  v_fix hrms.punch_fix_requests;
  v_label text;
  v_has_day boolean;
  v_outdoor_open boolean;
begin
  select timezone into v_tz from hrms.organizations where id = v_actor.org_id;
  select * into v_d from hrms.device_attendance_days
  where org_id = v_actor.org_id and employee_id = v_actor.employee_id and local_date = v_date;
  v_has_day := v_d.first_in_at is not null;
  if v_has_day then
    select d.label into v_label from hrms.device_punch_events p
    join hrms.attendance_devices d on d.serial = p.serial where p.id = v_d.first_in_punch_id;
  end if;
  select * into v_ow from hrms.outside_work
  where employee_id = v_actor.employee_id and work_date = v_date and kind = 'outdoor'
  order by revoked_at is null desc, created_at desc limit 1;
  v_outdoor_open := v_ow.id is not null and v_ow.revoked_at is null and v_ow.punch_out_at is null;
  select * into v_fix from hrms.punch_fix_requests
  where employee_id = v_actor.employee_id and local_date = v_date
  order by created_at desc limit 1;

  return hrms.ok(jsonb_build_object(
    'date', to_char(v_date, 'YYYY-MM-DD'),
    'is_today', v_date = v_today,
    'has_machines', hrms.org_has_machines(v_actor.org_id),
    'day', case when v_has_day then jsonb_build_object(
      'first_in_at', v_d.first_in_at, 'out_at', v_d.out_at, 'out_source', v_d.out_source,
      'worked_minutes', v_d.worked_minutes, 'scan_count', v_d.scan_count, 'machine', v_label,
      'machine_in_at', (select device_time from hrms.device_punch_events where id = v_d.first_in_punch_id),
      'in_corrected', v_d.corrected_in_at is not null, 'app_out_reason', v_d.app_out_reason,
      'correction_reason', v_d.correction_reason) end,
    'outdoor', case when v_ow.id is not null then hrms.outdoor_json(v_ow, v_actor) end,
    'fix', case when v_fix.id is not null then hrms.fix_json(v_fix, v_actor) end,
    'can_app_out', v_date >= v_today - 2 and (
      (v_has_day and v_d.scan_count = 1 and v_d.corrected_out_at is null and v_d.app_out_at is null)
      or (not v_has_day and v_outdoor_open)),
    'can_outdoor_in', v_date = v_today and not v_has_day
      and not exists (select 1 from hrms.outside_work w where w.employee_id = v_actor.employee_id
                      and w.work_date = v_date and w.revoked_at is null),
    'can_request_fix', v_has_day and (v_fix.id is null or v_fix.status <> 'pending')
  ));
end;
$$;

create or replace function public.app_punch_out(p_date text default null, p_out_time text default null, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_tz text;
  v_today date := hrms.org_today(v_actor.org_id);
  v_date date := hrms.parse_day(p_date, v_today, 2);
  v_out timestamptz;
  v_in timestamptz;
  v_reason text := hrms.clean_text(p_reason, 300);
  v_need_reason boolean;
  v_d hrms.device_attendance_days;
  v_ow hrms.outside_work;
  v_name text;
begin
  select timezone into v_tz from hrms.organizations where id = v_actor.org_id;
  v_out := hrms.local_clock(v_date, p_out_time, v_tz, 'out_time');
  if v_out is null then
    if v_date <> v_today then
      perform hrms.raise_error('VALIDATION_FAILED', 'Enter the time you left.', '{"out_time":"required"}'::jsonb);
    end if;
    v_out := now();
  end if;
  if v_out > now() + interval '1 minute' then
    perform hrms.raise_error('VALIDATION_FAILED', 'The punch-out cannot be in the future.', '{"out_time":"future"}'::jsonb);
  end if;
  v_need_reason := v_date <> v_today or now() - v_out > interval '15 minutes';
  if v_need_reason and (v_reason is null or char_length(v_reason) < 3) then
    perform hrms.raise_error('VALIDATION_FAILED', 'Say why you are setting an earlier time.', '{"reason":"required"}'::jsonb);
  end if;

  perform hrms.device_lock_org(v_actor.org_id);
  select * into v_d from hrms.device_attendance_days
  where org_id = v_actor.org_id and employee_id = v_actor.employee_id and local_date = v_date for update;

  if v_d.first_in_at is not null then
    if v_d.scan_count >= 2 then
      perform hrms.raise_error('CONFLICT', 'You already punched out at the machine that day.');
    elsif v_d.corrected_out_at is not null then
      perform hrms.raise_error('CONFLICT', 'HR has already set your punch-out for that day.');
    elsif v_d.app_out_at is not null then
      perform hrms.raise_error('CONFLICT', 'You already punched out from the app that day.');
    end if;
    v_in := v_d.first_in_at;
  else
    select * into v_ow from hrms.outside_work
    where employee_id = v_actor.employee_id and work_date = v_date and kind = 'outdoor' and revoked_at is null
    for update;
    if v_ow.id is null then
      perform hrms.raise_error('NOT_FOUND', 'There is no punch-in for that day. Punch in at the machine first.');
    elsif v_ow.punch_out_at is not null then
      perform hrms.raise_error('CONFLICT', 'You already punched out from the app that day.');
    end if;
    v_in := v_ow.punch_in_at;
  end if;
  if v_out <= v_in then
    perform hrms.raise_error('VALIDATION_FAILED', 'The punch-out must be after your punch-in at '
      || hrms.fmt_clock(v_in, v_tz) || '.', '{"out_time":"before_in"}'::jsonb);
  end if;
  if v_out >= (v_date + 1)::timestamp at time zone v_tz then
    perform hrms.raise_error('VALIDATION_FAILED', 'The punch-out must be on the same day.', '{"out_time":"next_day"}'::jsonb);
  end if;

  if v_ow.id is null then
    update hrms.device_attendance_days
    set app_out_at = v_out, app_out_reason = v_reason, app_out_set_at = now()
    where org_id = v_actor.org_id and employee_id = v_actor.employee_id and local_date = v_date;
    perform hrms.device_refresh_day(v_actor.org_id, v_actor.employee_id, v_date);
  else
    update hrms.outside_work set punch_out_at = v_out where id = v_ow.id;
  end if;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'attendance_day.app_out', 'employee', v_actor.employee_id,
    jsonb_build_object('date', v_date, 'out_at', v_out, 'reason', v_reason, 'outdoor', v_ow.id is not null),
    'business', v_actor.employee_id);
  if v_need_reason then
    select full_name into v_name from hrms.employees where id = v_actor.employee_id;
    perform hrms.notify(v_actor.org_id, w, 'attendance.app_out', left(v_name, 80) || ' punched out from the app',
      'For ' || to_char(v_date, 'DD Mon') || ' at ' || hrms.fmt_clock(v_out, v_tz) || '. Reason: ' || left(v_reason, 140),
      '/devices?date=' || to_char(v_date, 'YYYY-MM-DD'))
    from hrms.punch_watchers(v_actor.org_id, v_actor.employee_id, v_date) w;
  end if;
  return hrms.ok(jsonb_build_object('date', to_char(v_date, 'YYYY-MM-DD'), 'out_at', v_out));
end;
$$;

create or replace function public.outdoor_punch_in(
  p_reason text, p_photo_file_version_id uuid,
  p_latitude double precision default null, p_longitude double precision default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_today date := hrms.org_today(v_actor.org_id);
  v_reason text := hrms.clean_text(p_reason, 500);
  v_ver hrms.file_versions;
  v_rec hrms.file_records;
  v_errors jsonb := '{}'::jsonb;
  v_ow hrms.outside_work;
  v_name text;
begin
  if v_reason is null or char_length(v_reason) < 5 then
    v_errors := v_errors || '{"reason":"Say where you are and what the work is"}';
  end if;
  if p_photo_file_version_id is null then
    v_errors := v_errors || '{"photo":"Take a photo as proof"}';
  else
    select * into v_ver from hrms.file_versions where id = p_photo_file_version_id and org_id = v_actor.org_id;
    select * into v_rec from hrms.file_records where id = v_ver.file_record_id;
    if v_ver.id is null or v_rec.owner_employee_id is distinct from v_actor.employee_id
       or v_rec.class <> 'correction_attachment' or v_ver.state not in ('validated', 'published')
       or coalesce(v_ver.detected_mime, v_ver.declared_mime) not like 'image/%'
       or v_ver.created_at < now() - interval '1 hour' then
      v_errors := v_errors || '{"photo":"Take the photo again"}';
    end if;
  end if;
  if (p_latitude is null) <> (p_longitude is null)
     or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 then
    v_errors := v_errors || '{"location":"Invalid location"}';
  end if;
  if v_errors <> '{}'::jsonb then
    perform hrms.raise_error('VALIDATION_FAILED', 'Please check the highlighted fields.', v_errors);
  end if;

  perform hrms.device_lock_org(v_actor.org_id);
  if exists (select 1 from hrms.device_attendance_days d where d.org_id = v_actor.org_id
             and d.employee_id = v_actor.employee_id and d.local_date = v_today and d.first_in_at is not null) then
    perform hrms.raise_error('CONFLICT', 'You already punched in at the machine today.');
  end if;
  if exists (select 1 from hrms.outside_work w where w.employee_id = v_actor.employee_id
             and w.work_date = v_today and w.revoked_at is null) then
    perform hrms.raise_error('CONFLICT', 'Outside work is already recorded for you today.');
  end if;
  if (select count(*) from hrms.outside_work w where w.employee_id = v_actor.employee_id
      and w.work_date = v_today and w.kind = 'outdoor') >= 3 then
    perform hrms.raise_error('CONFLICT', 'Too many outdoor punch-ins today. Ask HR.');
  end if;

  insert into hrms.outside_work (org_id, employee_id, work_date, reason, granted_by, kind,
                                 punch_in_at, photo_file_version_id, latitude, longitude)
  values (v_actor.org_id, v_actor.employee_id, v_today, v_reason, v_actor.employee_id, 'outdoor',
          now(), p_photo_file_version_id, p_latitude, p_longitude)
  returning * into v_ow;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'attendance.outdoor_in', 'outside_work', v_ow.id,
    jsonb_build_object('date', v_today, 'reason', v_reason, 'photo', p_photo_file_version_id,
                       'has_location', p_latitude is not null),
    'business', v_actor.employee_id);
  select full_name into v_name from hrms.employees where id = v_actor.employee_id;
  perform hrms.notify(v_actor.org_id, w, 'attendance.outdoor_in', left(v_name, 80) || ' punched in for outdoor work',
    left(v_reason, 160), '/attendance/outdoor', jsonb_build_object('outside_work_id', v_ow.id))
  from hrms.punch_watchers(v_actor.org_id, v_actor.employee_id, v_today) w;
  return hrms.ok(hrms.outdoor_json(v_ow, v_actor));
end;
$$;

-- ------------------------------------------------------ HR / team leaders

create or replace function public.list_outdoor_punches(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_today date := hrms.org_today(v_actor.org_id);
  v_to date := coalesce(p_to, v_today);
  v_from date := coalesce(p_from, v_to - 6);
begin
  if v_from > v_to or v_to - v_from > 62 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Pick up to 62 days.', '{"from":"range"}'::jsonb);
  end if;
  return hrms.ok(jsonb_build_object('from', v_from, 'to', v_to, 'rows', coalesce((
    select jsonb_agg(hrms.outdoor_json(w, v_actor) order by w.work_date desc, w.punch_in_at desc)
    from hrms.outside_work w
    where w.org_id = v_actor.org_id and w.kind = 'outdoor' and w.work_date between v_from and v_to
      and (w.employee_id = v_actor.employee_id or hrms.can_see_work(v_actor, w.employee_id))
  ), '[]'::jsonb)));
end;
$$;

create or replace function public.reject_outdoor_punch(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_reason text := hrms.clean_text(p_reason, 500);
  v_ow hrms.outside_work;
begin
  select * into v_ow from hrms.outside_work where id = p_id and org_id = v_actor.org_id and kind = 'outdoor' for update;
  if v_ow.id is null or not (v_ow.employee_id = v_actor.employee_id or hrms.can_see_work(v_actor, v_ow.employee_id)) then
    perform hrms.raise_error('NOT_FOUND', 'That outdoor punch-in was not found.');
  end if;
  if v_ow.employee_id = v_actor.employee_id then
    perform hrms.raise_error('ACCESS_DENIED', 'You cannot reject your own punch-in.');
  end if;
  if v_ow.revoked_at is not null then
    perform hrms.raise_error('CONFLICT', 'It was already rejected.');
  end if;
  if v_reason is null or char_length(v_reason) < 3 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Say why it is rejected.', '{"reason":"required"}'::jsonb);
  end if;
  update hrms.outside_work set revoked_at = now(), revoked_by = v_actor.employee_id, revoke_reason = v_reason
  where id = v_ow.id returning * into v_ow;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'attendance.outdoor_rejected', 'outside_work', v_ow.id,
    jsonb_build_object('date', v_ow.work_date, 'reason', v_reason), 'business', v_ow.employee_id);
  perform hrms.notify(v_actor.org_id, v_ow.employee_id, 'attendance.outdoor_rejected',
    'Outdoor punch-in on ' || to_char(v_ow.work_date, 'DD Mon') || ' not accepted', left(v_reason, 160),
    '/attendance/today?date=' || to_char(v_ow.work_date, 'YYYY-MM-DD'));
  return hrms.ok(hrms.outdoor_json(v_ow, v_actor));
end;
$$;

-- -------------------------------------------------------- fix a punch time

create or replace function public.request_punch_fix(p_date text, p_in_time text, p_out_time text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_tz text;
  v_today date := hrms.org_today(v_actor.org_id);
  v_date date := hrms.parse_day(p_date, v_today, 31);
  v_in timestamptz;
  v_out timestamptz;
  v_reason text := hrms.clean_text(p_reason, 500);
  v_d hrms.device_attendance_days;
  v_r hrms.punch_fix_requests;
  v_name text;
begin
  select timezone into v_tz from hrms.organizations where id = v_actor.org_id;
  v_in := hrms.local_clock(v_date, p_in_time, v_tz, 'in_time');
  v_out := hrms.local_clock(v_date, p_out_time, v_tz, 'out_time');
  if v_in is null and v_out is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'Enter the right punch-in or punch-out time.', '{"in_time":"required"}'::jsonb);
  end if;
  if v_reason is null or char_length(v_reason) < 5 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Say what went wrong.', '{"reason":"required"}'::jsonb);
  end if;
  select * into v_d from hrms.device_attendance_days
  where org_id = v_actor.org_id and employee_id = v_actor.employee_id and local_date = v_date;
  if v_d.first_in_at is null then
    perform hrms.raise_error('NOT_FOUND', 'There is no punch for that day to fix.');
  end if;
  if coalesce(v_out, 'infinity') <= coalesce(v_in, v_d.first_in_at) then
    perform hrms.raise_error('VALIDATION_FAILED', 'The punch-out must be after the punch-in.', '{"out_time":"before_in"}'::jsonb);
  end if;
  if greatest(v_in, v_out) > now() + interval '1 minute' then
    perform hrms.raise_error('VALIDATION_FAILED', 'A time cannot be in the future.', '{"out_time":"future"}'::jsonb);
  end if;
  begin
    insert into hrms.punch_fix_requests (org_id, employee_id, local_date, in_at, out_at, reason)
    values (v_actor.org_id, v_actor.employee_id, v_date, v_in, v_out, v_reason)
    returning * into v_r;
  exception when unique_violation then
    perform hrms.raise_error('CONFLICT', 'You already asked for a fix for that day. Wait for HR, or withdraw it.');
  end;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'attendance.fix_requested', 'punch_fix_request', v_r.id,
    jsonb_build_object('date', v_date, 'in_at', v_in, 'out_at', v_out), 'business', v_actor.employee_id);
  select full_name into v_name from hrms.employees where id = v_actor.employee_id;
  perform hrms.notify(v_actor.org_id, e.id, 'attendance.fix_requested', left(v_name, 80) || ' asked to fix a punch',
    to_char(v_date, 'DD Mon') || ': ' || concat_ws(', ', 'in ' || hrms.fmt_clock(v_in, v_tz), 'out ' || hrms.fmt_clock(v_out, v_tz))
      || '. ' || left(v_reason, 120),
    '/attendance/fixes', jsonb_build_object('request_id', v_r.id))
  from hrms.employees e
  where e.org_id = v_actor.org_id and e.status = 'active' and e.id <> v_actor.employee_id
    and hrms.employee_roles(e.id) && array['hr', 'admin'];
  return hrms.ok(hrms.fix_json(v_r, v_actor));
end;
$$;

create or replace function public.withdraw_punch_fix(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_r hrms.punch_fix_requests;
begin
  update hrms.punch_fix_requests set status = 'withdrawn'
  where id = p_id and employee_id = v_actor.employee_id and status = 'pending'
  returning * into v_r;
  if v_r.id is null then
    perform hrms.raise_error('NOT_FOUND', 'There is no open request to withdraw.');
  end if;
  return hrms.ok(hrms.fix_json(v_r, v_actor));
end;
$$;

create or replace function public.list_punch_fixes(p_status text default 'pending') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_all boolean := hrms.is_hr_or_admin(v_actor);
begin
  if coalesce(p_status, '') not in ('pending', 'done', 'all') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown filter.');
  end if;
  return hrms.ok(coalesce((
    select jsonb_agg(hrms.fix_json(r, v_actor) order by r.created_at desc)
    from (select * from hrms.punch_fix_requests r
          where r.org_id = v_actor.org_id
            and (v_all or r.employee_id = v_actor.employee_id)
            and (p_status = 'all' or (p_status = 'pending') = (r.status = 'pending'))
          order by r.created_at desc limit 200) r
  ), '[]'::jsonb));
end;
$$;

create or replace function public.review_punch_fix(p_id uuid, p_approve boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_tz text;
  v_note text := hrms.clean_text(p_note, 300);
  v_r hrms.punch_fix_requests;
  v_d hrms.device_attendance_days;
begin
  select timezone into v_tz from hrms.organizations where id = v_actor.org_id;
  select * into v_r from hrms.punch_fix_requests where id = p_id and org_id = v_actor.org_id for update;
  if v_r.id is null then perform hrms.raise_error('NOT_FOUND', 'Request not found.'); end if;
  if v_r.employee_id = v_actor.employee_id then
    perform hrms.raise_error('ACCESS_DENIED', 'Someone else must review your own request.');
  end if;
  if v_r.status <> 'pending' then perform hrms.raise_error('CONFLICT', 'This request was already handled.'); end if;
  if not p_approve and (v_note is null or char_length(v_note) < 3) then
    perform hrms.raise_error('VALIDATION_FAILED', 'Say why it is rejected.', '{"note":"required"}'::jsonb);
  end if;

  if p_approve then
    perform hrms.device_lock_org(v_actor.org_id);
    select * into v_d from hrms.device_attendance_days
    where org_id = v_actor.org_id and employee_id = v_r.employee_id and local_date = v_r.local_date for update;
    if v_d.first_in_at is null then perform hrms.raise_error('NOT_FOUND', 'The punch for that day is gone.'); end if;
    if v_r.out_at is not null and v_r.out_at <= coalesce(v_r.in_at, v_d.first_in_at) then
      perform hrms.raise_error('CONFLICT', 'The punch-out would be before the punch-in. Fix it by hand instead.');
    end if;
    if v_r.in_at is not null and v_r.out_at is null and v_d.out_at is not null and v_d.out_at <= v_r.in_at then
      perform hrms.raise_error('CONFLICT', 'The punch-in would be after the punch-out. Fix it by hand instead.');
    end if;
    update hrms.device_attendance_days set
      corrected_in_at = coalesce(v_r.in_at, corrected_in_at),
      corrected_out_at = coalesce(v_r.out_at, corrected_out_at),
      correction_reason = left('Fix request: ' || v_r.reason, 300),
      corrected_by = v_actor.employee_id,
      corrected_at = now()
    where org_id = v_actor.org_id and employee_id = v_r.employee_id and local_date = v_r.local_date;
    perform hrms.device_refresh_day(v_actor.org_id, v_r.employee_id, v_r.local_date);
  end if;

  update hrms.punch_fix_requests set status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_by = v_actor.employee_id, reviewed_at = now(), review_note = v_note
  where id = v_r.id returning * into v_r;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id,
    case when p_approve then 'attendance.fix_approved' else 'attendance.fix_rejected' end,
    'punch_fix_request', v_r.id, jsonb_build_object('date', v_r.local_date, 'in_at', v_r.in_at, 'out_at', v_r.out_at, 'note', v_note),
    'business', v_r.employee_id);
  perform hrms.notify(v_actor.org_id, v_r.employee_id,
    case when p_approve then 'attendance.fix_approved' else 'attendance.fix_rejected' end,
    case when p_approve then 'Punch fixed for ' else 'Punch fix not accepted for ' end || to_char(v_r.local_date, 'DD Mon'),
    coalesce(v_note, case when p_approve then 'Your times were updated.' end),
    '/attendance/today?date=' || to_char(v_r.local_date, 'YYYY-MM-DD'));
  return hrms.ok(hrms.fix_json(v_r, v_actor));
end;
$$;

select hrms.apply_api_grants();
