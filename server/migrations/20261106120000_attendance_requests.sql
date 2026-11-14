-- [web-hrms] Ported from ~/Documents/Projects/September/HRMS/hrms/supabase/migrations/20261106120000_attendance_requests.sql
-- [web-hrms]   unchanged

-- =============================================================================
-- Attendance requests reviewed by the HR/Admin pool (owner decision 2026-11-06)
--
--   * leave, correction, late_excuse (new) and wfh (new) are reviewed by ANY
--     active HR or Admin who is not the requester. All of them are notified
--     when a request is submitted; whoever opens it first reviews it.
--   * Late arrival request: an approved request excuses that day's late mark,
--     so it never counts towards the "4 lates = 1 day cut" rule.
--   * Work from home request: approval marks the chosen working days as
--     outside work ("Work from home"): no check-in needed, full day credited.
--   * HR can now also grant / revoke outside work directly (was Admin only).
-- =============================================================================

alter table hrms.requests drop constraint requests_kind_check;
alter table hrms.requests add constraint requests_kind_check check (kind in (
  'leave', 'correction', 'bank_details', 'profile_details', 'employee_details',
  'employee_assignment', 'employee_status', 'salary_change', 'payslip_publish',
  'late_excuse', 'wfh'
));

create table hrms.late_excuses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references hrms.organizations(id) on delete restrict,
  employee_id uuid not null references hrms.employees(id) on delete restrict,
  shift_date date not null,
  request_id uuid references hrms.requests(id) on delete restrict,
  approved_by uuid not null references hrms.employees(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references hrms.employees(id),
  revoke_reason text check (char_length(revoke_reason) <= 500)
);
create unique index late_excuses_active on hrms.late_excuses (employee_id, shift_date) where revoked_at is null;
alter table hrms.late_excuses enable row level security;

-- Outside work and Work from home share the "credited day, no check-in" table
-- but are different things:
--   outside — HR/Admin sends people to work away from the office (site visit,
--             client, event). Granted directly; the employee does not ask.
--   wfh     — the employee asks to work from home; HR/Admin approves the request.
-- The attendance source is 'outside' or 'wfh' accordingly, and each is counted
-- and labelled separately everywhere.
alter table hrms.outside_work
  add column request_id uuid references hrms.requests(id) on delete restrict,
  add column kind text not null default 'outside' check (kind in ('outside', 'wfh')),
  add constraint outside_work_wfh_has_request check (kind = 'outside' or request_id is not null);

-- -----------------------------------------------------------------------------
-- Pool routing
-- -----------------------------------------------------------------------------
create or replace function hrms.is_pool_kind(p_kind text) returns boolean
language sql immutable set search_path = '' as $$
  select p_kind in ('leave', 'correction', 'late_excuse', 'wfh');
$$;

create or replace function hrms.resolve_reviewer(
  p_org uuid, p_employee uuid, p_kind text, p_day date
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_team uuid := coalesce(hrms.team_on(p_employee, p_day), hrms.team_on(p_employee, hrms.org_today(p_org)));
  v_primary uuid;
begin
  -- Every request kind that reaches this function is reviewed by the HR/Admin
  -- pool. The "assigned" reviewer is only a default owner (HR before Admin);
  -- anyone in the pool can open it.
  select e.id into v_primary
  from hrms.employees e
  where e.org_id = p_org
    and hrms.is_hr_admin_reviewer(e.id, p_employee)
  order by case when 'hr' = any(hrms.employee_roles(e.id))
                          and not ('admin' = any(hrms.employee_roles(e.id))) then 0 else 1 end,
           e.employee_code, e.id
  limit 1;
  return jsonb_build_object(
    'reviewer_id', v_primary, 'team_id', v_team, 'mode', 'hr_admin',
    'reason', case when v_primary is null then 'no_eligible_reviewer' end);
end;
$$;

create or replace function hrms.review_authority(
  p_actor hrms.actor, p_req hrms.requests
) returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_req.org_id <> p_actor.org_id or p_req.employee_id = p_actor.employee_id then
    return null;
  end if;
  if hrms.is_employee_change_kind(p_req.kind)
     or (p_req.kind = 'bank_details'
         and p_req.route_snapshot ->> 'initiator_class' in ('employee', 'hr')) then
    return hrms.change_review_authority(p_actor, p_req);
  end if;
  if hrms.is_pool_kind(p_req.kind) then
    if not hrms.is_hr_or_admin(p_actor) then return null; end if;
    if p_req.assigned_reviewer_id = p_actor.employee_id then return 'assigned'; end if;
    return 'pool';
  end if;
  if p_req.kind = 'bank_details'
     and p_req.route_snapshot ->> 'mode' = 'change'
     and not hrms.is_admin(p_actor) then return null; end if;
  if p_req.assigned_reviewer_id = p_actor.employee_id then return 'assigned'; end if;
  if hrms.is_admin(p_actor) then return 'admin'; end if;
  return null;
end;
$$;

-- "Mine" for HR/Admin = everything they can review in the pool, plus anything
-- assigned to them personally.
create or replace function public.list_review_queue(
  p_kind text default null, p_scope text default 'mine', p_state text default null,
  p_limit integer default 25, p_before_submitted_at timestamptz default null,
  p_before_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_rows jsonb;
begin
  if p_scope not in ('mine', 'all', 'unassigned') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown scope');
  end if;
  if p_scope = 'all' and not hrms.is_admin(v_actor) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  if p_scope = 'unassigned' and not hrms.is_hr_or_admin(v_actor) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  if p_state is not null and p_state not in (
    'completed', 'submitted', 'under_review', 'approved', 'rejected', 'cancelled',
    'withdrawal_pending', 'cancellation_pending'
  ) then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown review status.');
  end if;
  select coalesce(
    jsonb_agg(hrms.request_summary(r) order by r.submitted_at desc, r.id desc),
    '[]'::jsonb) into v_rows
  from (
    select *
    from hrms.requests r
    where r.org_id = v_actor.org_id
      and r.employee_id <> v_actor.employee_id
      and r.state <> 'draft'
      and hrms.review_authority(v_actor, r) is not null
      and case
        when p_state is null then r.state in (
          'submitted', 'under_review', 'withdrawal_pending', 'cancellation_pending')
        when p_state = 'completed' then r.state in ('approved', 'rejected', 'cancelled')
        else r.state = p_state end
      and (p_kind is null or r.kind = p_kind)
      and case p_scope
        when 'mine' then r.assigned_reviewer_id = v_actor.employee_id or hrms.is_pool_kind(r.kind)
        when 'unassigned' then r.assigned_reviewer_id is null
          or (hrms.is_pool_kind(r.kind) and not hrms.is_hr_admin_reviewer(r.assigned_reviewer_id, r.employee_id))
        else true end
      and (p_before_submitted_at is null
           or (r.submitted_at, r.id) < (p_before_submitted_at, p_before_id))
    order by r.submitted_at desc, r.id desc
    limit v_limit
  ) r;
  return hrms.ok(v_rows);
end;
$$;

create or replace function hrms.pending_review_count(p_actor hrms.actor) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from hrms.requests r
  where r.org_id = p_actor.org_id and r.employee_id <> p_actor.employee_id
    and r.state in ('submitted', 'under_review', 'withdrawal_pending', 'cancellation_pending')
    and (r.assigned_reviewer_id = p_actor.employee_id
         or (hrms.is_pool_kind(r.kind) and hrms.is_hr_or_admin(p_actor)))
    and hrms.review_authority(p_actor, r) is not null;
$$;

create or replace function hrms.change_category_label(p_kind text) returns text
language sql immutable set search_path = '' as $$
  select case p_kind
    when 'leave' then 'Leave'
    when 'correction' then 'Attendance correction'
    when 'late_excuse' then 'Late arrival'
    when 'wfh' then 'Work from home'
    when 'profile_details' then 'Profile details'
    when 'employee_details' then 'Employee details'
    when 'employee_assignment' then 'Employee assignment'
    when 'employee_status' then 'Employee status'
    when 'salary_change' then 'Salary change'
    when 'payslip_publish' then 'Payslip publication'
    when 'bank_details' then 'Bank details'
    else 'Request' end;
$$;

-- -----------------------------------------------------------------------------
-- Notify the whole HR/Admin pool when an attendance request is submitted.
-- The assigned reviewer is already notified by the save function.
-- Copy names the employee and dates only — never reasons or leave type.
-- -----------------------------------------------------------------------------
create or replace function hrms.fmt_day_range(p_from date, p_to date) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_from is null then ''
    when p_to is null or p_to = p_from then 'on ' || to_char(p_from, 'FMDD Mon')
    when date_trunc('month', p_from) = date_trunc('month', p_to)
      then to_char(p_from, 'FMDD') || '–' || to_char(p_to, 'FMDD Mon')
    else to_char(p_from, 'FMDD Mon') || ' – ' || to_char(p_to, 'FMDD Mon') end;
$$;

create or replace function hrms.notify_pool_on_submit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_req hrms.requests;
  v_name text;
  v_title text;
  v_body text;
begin
  if new.action not in ('submitted', 'resubmitted') then return null; end if;
  select * into v_req from hrms.requests where id = new.request_id;
  if not found or not hrms.is_pool_kind(v_req.kind) then return null; end if;
  select left(e.full_name, 90) into v_name from hrms.employees e where e.id = v_req.employee_id;
  v_title := case v_req.kind
    when 'leave' then 'Leave request'
    when 'correction' then 'Attendance correction request'
    when 'late_excuse' then 'Late arrival request'
    else 'Work from home request' end;
  v_body := v_name || case v_req.kind
    when 'leave' then ' applied for leave ' || hrms.fmt_day_range(v_req.start_date, v_req.end_date)
    when 'correction' then ' asked to correct attendance ' || hrms.fmt_day_range(v_req.target_shift_date, null)
    when 'late_excuse' then ' asked to excuse a late arrival ' || hrms.fmt_day_range(v_req.target_shift_date, null)
    else ' asked to work from home ' || hrms.fmt_day_range(v_req.start_date, v_req.end_date) end
    || '. Tap to approve or reject.';
  perform hrms.notify(v_req.org_id, e.id, 'request.submitted', v_title, v_body, '/approvals/' || v_req.id,
    jsonb_build_object('request_id', v_req.id, 'kind', v_req.kind),
    md5(v_req.id::text || ':pool:' || new.id::text || ':' || e.id::text)::uuid)
  from hrms.employees e
  where e.org_id = v_req.org_id
    and e.id is distinct from v_req.assigned_reviewer_id
    and hrms.is_hr_admin_reviewer(e.id, v_req.employee_id);
  return null;
end;
$$;

create trigger approval_events_notify_pool after insert on hrms.approval_events
  for each row execute function hrms.notify_pool_on_submit();

-- -----------------------------------------------------------------------------
-- Late arrival and Work from home: validation, save/submit, apply on approval
-- -----------------------------------------------------------------------------
create or replace function hrms.validate_attendance_request(
  p_actor hrms.actor, p_kind text, p_from date, p_to date, p_request_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := hrms.org_today(p_actor.org_id);
  v_to date := coalesce(p_to, p_from);
  v_days jsonb;
  v_inst hrms.work_schedule_instances;
begin
  if p_from is null then
    return jsonb_build_object('errors', '{"start_date":"Choose a date"}'::jsonb);
  end if;

  if p_kind = 'late_excuse' then
    if p_from < v_today - 31 or p_from > v_today + 30 then
      return jsonb_build_object('errors', '{"start_date":"Choose a day within the last 31 or next 30 days"}'::jsonb);
    end if;
    perform hrms.ensure_schedule_instances(p_actor.org_id, array[p_actor.employee_id], p_from, p_from);
    select * into v_inst from hrms.work_schedule_instances
    where employee_id = p_actor.employee_id and shift_date = p_from;
    if not found or not v_inst.is_required then
      return jsonb_build_object('errors', '{"start_date":"This is not a working day for you"}'::jsonb);
    end if;
    if hrms.approved_leave_slots(p_actor.employee_id, p_from) = 3 then
      return jsonb_build_object('errors', '{"start_date":"You are on leave that day"}'::jsonb);
    end if;
    if exists (select 1 from hrms.late_excuses where employee_id = p_actor.employee_id and shift_date = p_from
               and revoked_at is null) then
      return jsonb_build_object('errors', '{"start_date":"A late arrival is already approved for this day"}'::jsonb);
    end if;
    if exists (select 1 from hrms.requests r where r.employee_id = p_actor.employee_id and r.kind = 'late_excuse'
               and r.target_shift_date = p_from and r.id is distinct from p_request_id
               and r.state in ('draft', 'submitted', 'under_review', 'returned')) then
      return jsonb_build_object('errors', '{"start_date":"You already have a late arrival request for this day"}'::jsonb);
    end if;
    return jsonb_build_object('errors', '{}'::jsonb, 'days', jsonb_build_array(p_from),
                              'shift_start_at', v_inst.start_at);
  end if;

  -- wfh
  if v_to < p_from or v_to - p_from > 30 then
    return jsonb_build_object('errors', '{"end_date":"Choose up to 31 days"}'::jsonb);
  end if;
  if p_from < v_today - 7 or v_to > v_today + 60 then
    return jsonb_build_object('errors', '{"start_date":"Choose dates from the last 7 days up to 60 days ahead"}'::jsonb);
  end if;
  perform hrms.ensure_schedule_instances(p_actor.org_id, array[p_actor.employee_id], p_from, v_to);
  select coalesce(jsonb_agg(w.shift_date order by w.shift_date), '[]'::jsonb) into v_days
  from hrms.work_schedule_instances w
  where w.employee_id = p_actor.employee_id and w.shift_date between p_from and v_to
    and w.is_required and w.kind in ('workday', 'extra_workday')
    and hrms.approved_leave_slots(p_actor.employee_id, w.shift_date) < 3
    and not exists (select 1 from hrms.attendance_sessions s where s.schedule_instance_id = w.id)
    and not exists (select 1 from hrms.outside_work o where o.employee_id = w.employee_id
                    and o.work_date = w.shift_date and o.revoked_at is null);
  if jsonb_array_length(v_days) = 0 then
    return jsonb_build_object('errors',
      '{"start_date":"There are no working days to request in these dates"}'::jsonb);
  end if;
  if exists (select 1 from hrms.requests r where r.employee_id = p_actor.employee_id and r.kind = 'wfh'
             and r.id is distinct from p_request_id
             and r.state in ('draft', 'submitted', 'under_review', 'returned')
             and daterange(r.start_date, r.end_date, '[]') && daterange(p_from, v_to, '[]')) then
    return jsonb_build_object('errors', '{"start_date":"You already have a work from home request for these dates"}'::jsonb);
  end if;
  return jsonb_build_object('errors', '{}'::jsonb, 'days', v_days);
end;
$$;

create or replace function hrms.apply_attendance_request(
  p_req hrms.requests, p_payload jsonb, p_approver uuid
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_req.kind = 'late_excuse' then
    insert into hrms.late_excuses (org_id, employee_id, shift_date, request_id, approved_by)
    values (p_req.org_id, p_req.employee_id, (p_payload ->> 'shift_date')::date, p_req.id, p_approver)
    on conflict (employee_id, shift_date) where revoked_at is null do nothing;
  elsif p_req.kind = 'wfh' then
    insert into hrms.outside_work (org_id, employee_id, work_date, reason, granted_by, request_id, kind)
    select p_req.org_id, p_req.employee_id, d::date,
           coalesce(left(nullif(btrim(p_payload ->> 'reason'), ''), 500), 'Work from home'),
           p_approver, p_req.id, 'wfh'
    from jsonb_array_elements_text(p_payload -> 'days') d
    where not exists (select 1 from hrms.attendance_sessions s
                      where s.employee_id = p_req.employee_id and s.shift_date = d::date)
    on conflict (employee_id, work_date) where revoked_at is null do nothing;
  end if;
end;
$$;

-- One save/submit endpoint for the two new kinds (same lifecycle as
-- corrections: editable until a reviewer opens it; Admin auto-approves own).
create or replace function public.save_attendance_request(
  p_kind text,
  p_request_id uuid,
  p_start_date date,
  p_end_date date,
  p_reason text,
  p_submit boolean,
  p_expected_version integer,
  p_operation_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_req hrms.requests;
  v_check jsonb;
  v_replay jsonb;
  v_route jsonb;
  v_prev_state text;
  v_payload jsonb;
  v_reason text := hrms.clean_text(p_reason, 1000);
  v_end date := case when p_kind = 'late_excuse' then p_start_date else coalesce(p_end_date, p_start_date) end;
  v_result jsonb;
  v_units integer;
begin
  if p_kind not in ('late_excuse', 'wfh') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown request type.');
  end if;
  v_replay := hrms.idem_claim(v_actor.employee_id, v_actor.org_id, p_kind || '.save', p_operation_key,
    hrms.sha256_hex(concat_ws('|', p_kind, p_request_id, p_start_date, v_end, v_reason, p_submit, p_expected_version)));
  if v_replay is not null then return v_replay; end if;

  if v_reason is null or char_length(v_reason) < 3 then
    perform hrms.raise_error('VALIDATION_FAILED', 'A reason is required.', '{"reason":"Tell HR why"}'::jsonb);
  end if;

  if p_request_id is not null then
    select * into v_req from hrms.requests where id = p_request_id for update;
    if not found or v_req.employee_id <> v_actor.employee_id or v_req.kind <> p_kind then
      perform hrms.raise_error('ACCESS_DENIED');
    end if;
    if v_req.state in ('under_review', 'withdrawal_pending') then
      perform hrms.raise_error('REQUEST_LOCKED', 'HR has opened this request. Contact them for changes.');
    end if;
    if v_req.state not in ('draft', 'submitted', 'returned') then
      perform hrms.raise_error('REQUEST_LOCKED', 'This request can no longer be edited.');
    end if;
    if v_req.version <> p_expected_version then
      perform hrms.raise_error('STALE_VERSION', 'This request changed. Reload and try again.', null, true);
    end if;
  end if;

  v_check := hrms.validate_attendance_request(v_actor, p_kind, p_start_date, v_end, p_request_id);
  if v_check -> 'errors' <> '{}'::jsonb then
    perform hrms.raise_error('VALIDATION_FAILED', 'Please check the request.', v_check -> 'errors');
  end if;
  v_units := jsonb_array_length(v_check -> 'days');
  v_payload := case when p_kind = 'late_excuse'
    then jsonb_build_object('shift_date', p_start_date, 'reason', v_reason,
                            'shift_start_at', v_check -> 'shift_start_at')
    else jsonb_build_object('start_date', p_start_date, 'end_date', v_end, 'days', v_check -> 'days',
                            'reason', v_reason) end;

  if p_request_id is null then
    insert into hrms.requests (org_id, employee_id, kind, state, start_date, end_date, units, target_shift_date)
    values (v_actor.org_id, v_actor.employee_id, p_kind, 'draft',
            case when p_kind = 'wfh' then p_start_date end, case when p_kind = 'wfh' then v_end end,
            v_units, case when p_kind = 'late_excuse' then p_start_date end)
    returning * into v_req;
    insert into hrms.request_revisions (request_id, revision_no, payload, created_by)
    values (v_req.id, 1, v_payload, v_actor.employee_id);
    v_prev_state := 'draft';
  else
    v_prev_state := v_req.state;
    update hrms.requests
       set current_revision = current_revision + 1, version = version + 1, edited = (v_req.state <> 'draft'),
           start_date = case when p_kind = 'wfh' then p_start_date end,
           end_date = case when p_kind = 'wfh' then v_end end, units = v_units,
           target_shift_date = case when p_kind = 'late_excuse' then p_start_date end
     where id = v_req.id
    returning * into v_req;
    insert into hrms.request_revisions (request_id, revision_no, payload, created_by)
    values (v_req.id, v_req.current_revision, v_payload, v_actor.employee_id);
  end if;

  if p_submit then
    if v_prev_state in ('draft', 'returned') and hrms.is_admin(v_actor) then
      perform hrms.apply_attendance_request(v_req, v_payload, v_actor.employee_id);
      update hrms.requests
         set state = 'approved', submitted_at = now(), decided_at = now(), decided_by = v_actor.employee_id,
             approved_revision = current_revision, assigned_reviewer_id = null,
             route_snapshot = jsonb_build_object('mode', 'self_admin'), version = version + 1
       where id = v_req.id
      returning * into v_req;
      perform hrms.request_event(v_req, 'auto_approved', v_actor.employee_id, null, v_prev_state, 'approved');
    elsif v_prev_state in ('draft', 'returned') then
      v_route := hrms.resolve_reviewer(v_actor.org_id, v_actor.employee_id, p_kind, p_start_date);
      update hrms.requests
         set state = 'submitted', submitted_at = now(), version = version + 1,
             assigned_reviewer_id = case when v_prev_state = 'returned' then assigned_reviewer_id
                                         else (v_route ->> 'reviewer_id')::uuid end,
             route_snapshot = case when v_prev_state = 'returned' then route_snapshot else v_route end
       where id = v_req.id
      returning * into v_req;
      perform hrms.request_event(v_req, case when v_prev_state = 'returned' then 'resubmitted' else 'submitted' end,
                                 v_actor.employee_id, null, v_prev_state, 'submitted');
      if v_req.assigned_reviewer_id is null then
        perform hrms.alert_missing_reviewer(v_req);
      else
        perform hrms.notify_request(v_req, v_req.assigned_reviewer_id, 'request.submitted',
          case when p_kind = 'wfh' then 'Work from home request' else 'Late arrival request' end,
          (select left(full_name, 90) from hrms.employees where id = v_actor.employee_id)
            || case when p_kind = 'wfh' then ' asked to work from home ' || hrms.fmt_day_range(p_start_date, v_end)
                    else ' asked to excuse a late arrival ' || hrms.fmt_day_range(p_start_date, null) end
            || '. Tap to approve or reject.', true);
      end if;
    else
      perform hrms.request_event(v_req, 'edited', v_actor.employee_id, null, v_prev_state, v_req.state);
    end if;
  elsif v_prev_state = 'submitted' then
    perform hrms.raise_error('VALIDATION_FAILED', 'A submitted request can only be saved by submitting it.');
  end if;

  perform hrms.audit(v_actor.org_id, v_actor.employee_id,
    p_kind || case when p_request_id is null then '.created' else '.edited' end, 'request', v_req.id,
    jsonb_build_object('revision', v_req.current_revision, 'state', v_req.state, 'from', p_start_date, 'to', v_end),
    'business', v_actor.employee_id);

  v_result := hrms.ok(hrms.request_detail(v_req), v_req.version);
  perform hrms.idem_complete(v_actor.employee_id, p_kind || '.save', p_operation_key, v_result);
  return v_result;
end;
$$;

-- HR/Admin can withdraw an approved late excuse (e.g. approved by mistake).
create or replace function public.revoke_late_excuse(p_employee_id uuid, p_shift_date date, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_reason text := hrms.clean_text(p_reason, 500);
  v_row hrms.late_excuses;
begin
  if not hrms.is_hr_or_admin(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if v_reason is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'A reason is required.', '{"reason":"Required"}'::jsonb);
  end if;
  update hrms.late_excuses set revoked_at = now(), revoked_by = v_actor.employee_id, revoke_reason = v_reason
  where employee_id = p_employee_id and shift_date = p_shift_date and org_id = v_actor.org_id and revoked_at is null
  returning * into v_row;
  if not found then perform hrms.raise_error('ACCESS_DENIED'); end if;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'attendance.late_excuse_revoked', 'employee',
    p_employee_id, jsonb_build_object('shift_date', p_shift_date, 'reason', v_reason), 'business', p_employee_id);
  perform hrms.notify(v_actor.org_id, p_employee_id, 'attendance.late_excuse_revoked', 'Late approval withdrawn',
    'HR withdrew the late arrival approval ' || hrms.fmt_day_range(p_shift_date, null) || '.', '/attendance', null, null);
  return hrms.ok(jsonb_build_object('id', v_row.id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Decision core: apply the two new kinds on approval.
-- -----------------------------------------------------------------------------
create or replace function hrms.decide_request_core(
  p_actor hrms.actor, p_request_id uuid, p_decision text,
  p_reason text, p_expected_version integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_req hrms.requests;
  v_authority text;
  v_reason text := hrms.clean_text(p_reason, 1000);
  v_payload jsonb;
  v_to text;
begin
  if p_decision not in ('approve', 'reject', 'return') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown decision');
  end if;
  select * into v_req from hrms.requests where id = p_request_id for update;
  if not found then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if v_req.employee_id = p_actor.employee_id then
    perform hrms.raise_error('SELF_APPROVAL_FORBIDDEN', 'You cannot decide your own request.');
  end if;
  v_authority := hrms.review_authority(p_actor, v_req);
  if v_authority is null then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if v_req.state <> 'under_review' or v_req.version <> p_expected_version
     or v_req.locked_revision is distinct from v_req.current_revision then
    perform hrms.raise_error(
      'STALE_VERSION', 'This request changed. Reload it before deciding.', null, true);
  end if;
  if (p_decision in ('reject', 'return') or v_authority = 'admin') and v_reason is null then
    perform hrms.raise_error(
      'VALIDATION_FAILED', 'A reason is required.', '{"reason":"Required"}'::jsonb);
  end if;

  select payload into v_payload from hrms.request_revisions
  where request_id = v_req.id and revision_no = v_req.locked_revision;
  if not found then perform hrms.raise_error('STALE_VERSION', 'The reviewed revision is unavailable.'); end if;

  if p_decision = 'approve' then
    if v_req.kind = 'leave' then
      if hrms.leave_attendance_conflicts(v_req.employee_id, v_payload -> 'days') > 0 then
        perform hrms.raise_error('LEAVE_ATTENDANCE_CONFLICT',
          'Attendance was recorded during this leave. Return it for correction instead.');
      end if;
      perform hrms.debit_request(v_req.id, v_req.current_revision, p_actor.employee_id);
    elsif v_req.kind = 'correction' then
      perform hrms.apply_correction(v_req, v_payload, p_actor.employee_id, v_reason);
    elsif v_req.kind in ('late_excuse', 'wfh') then
      perform hrms.apply_attendance_request(v_req, v_payload, p_actor.employee_id);
    elsif v_req.kind = 'bank_details' then
      perform hrms.apply_bank_details(v_req, v_payload, p_actor);
    else
      perform hrms.apply_employee_change(v_req, v_payload, p_actor);
    end if;
    v_to := 'approved';
  elsif p_decision = 'reject' then
    perform hrms.release_request_holds(v_req.id);
    v_to := 'rejected';
  else
    perform hrms.release_request_holds(v_req.id);
    v_to := 'returned';
  end if;

  update hrms.requests set
    state = v_to, version = version + 1, decided_at = now(),
    decided_by = p_actor.employee_id,
    approved_revision = case when v_to = 'approved' then current_revision else approved_revision end
  where id = v_req.id returning * into v_req;
  perform hrms.request_event(v_req,
    case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' else 'returned' end,
    p_actor.employee_id, v_reason, 'under_review', v_to);
  perform hrms.notify_request(v_req, v_req.employee_id, 'request.' || v_to,
    case when v_to = 'approved' then hrms.change_category_label(v_req.kind) || ' approved'
         when v_to = 'rejected' then hrms.change_category_label(v_req.kind) || ' not approved'
         else hrms.change_category_label(v_req.kind) || ' returned for changes' end,
    case when v_to = 'returned' then 'HR asked for changes. Open the request to update it.'
         when v_req.kind = 'wfh' and v_to = 'approved'
           then 'You can work from home ' || hrms.fmt_day_range(v_req.start_date, v_req.end_date)
                || '. No check-in is needed on those days.'
         when v_req.kind = 'late_excuse' and v_to = 'approved'
           then 'Your late arrival ' || hrms.fmt_day_range(v_req.target_shift_date, null)
                || ' will not count towards salary deductions.'
         else 'Open the app to see the details.' end, false);
  perform hrms.audit(p_actor.org_id, p_actor.employee_id, 'request.' || p_decision,
    'request', v_req.id,
    jsonb_build_object('revision', v_req.current_revision, 'authority', v_authority,
                       'reason', v_reason, 'category', v_req.kind,
                       'target_employee_id', hrms.change_target_employee(v_req)),
    'business', hrms.change_target_employee(v_req));
  return hrms.ok(hrms.request_detail(v_req), v_req.version);
end;
$$;

-- -----------------------------------------------------------------------------
-- Outside work: HR or Admin.
-- -----------------------------------------------------------------------------
create or replace function public.grant_outside_work(
  p_employee_ids uuid[], p_from date, p_to date, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_reason text := hrms.clean_text(p_reason, 500);
  v_ids uuid[];
  v_count integer;
begin
  if not hrms.is_hr_or_admin(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 30 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Pick up to 31 days.', '{"dates":"Pick up to 31 days"}'::jsonb);
  end if;
  if v_reason is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'A reason is required.', '{"reason":"Required"}'::jsonb);
  end if;
  select array_agg(e.id) into v_ids from hrms.employees e
  where e.org_id = v_actor.org_id and e.status = 'active' and e.id = any(p_employee_ids);
  if v_ids is null or cardinality(p_employee_ids) > 200 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose people to send out.', '{"employees":"Choose people"}'::jsonb);
  end if;
  insert into hrms.outside_work (org_id, employee_id, work_date, reason, granted_by)
  select v_actor.org_id, e, d::date, v_reason, v_actor.employee_id
  from unnest(v_ids) e cross join generate_series(p_from, p_to, interval '1 day') d
  on conflict (employee_id, work_date) where revoked_at is null do nothing;
  get diagnostics v_count = row_count;
  perform hrms.ensure_schedule_instances(v_actor.org_id, v_ids, p_from, p_to);
  perform hrms.notify(v_actor.org_id, e, 'attendance.outside_work', 'Outside work assigned',
    'You are on outside work ' || hrms.fmt_day_range(p_from, p_to) || ' (' || v_reason
      || '). No check-in is needed on those days.', '/attendance', null,
    md5(e::text || ':outside:' || p_from::text || ':' || p_to::text)::uuid)
  from unnest(v_ids) e;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'attendance.outside_work_granted', 'organization',
    v_actor.org_id, jsonb_build_object('employees', to_jsonb(v_ids), 'from', p_from, 'to', p_to,
                                       'reason', v_reason, 'days_added', v_count));
  return hrms.ok(jsonb_build_object('days_added', v_count));
end;
$$;

create or replace function public.revoke_outside_work(p_id uuid, p_reason text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_reason text := hrms.clean_text(p_reason, 500);
  v_row hrms.outside_work;
begin
  if not hrms.is_hr_or_admin(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if v_reason is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'A reason is required.', '{"reason":"Required"}'::jsonb);
  end if;
  update hrms.outside_work set revoked_at = now(), revoked_by = v_actor.employee_id, revoke_reason = v_reason
  where id = p_id and org_id = v_actor.org_id and revoked_at is null
  returning * into v_row;
  if not found then perform hrms.raise_error('ACCESS_DENIED'); end if;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'attendance.outside_work_revoked', 'employee',
    v_row.employee_id, jsonb_build_object('work_date', v_row.work_date, 'reason', v_reason), 'business',
    v_row.employee_id);
  perform hrms.notify(v_actor.org_id, v_row.employee_id,
    case v_row.kind when 'wfh' then 'attendance.wfh_revoked' else 'attendance.outside_work_revoked' end,
    case v_row.kind when 'wfh' then 'Work from home cancelled' else 'Outside work cancelled' end,
    case v_row.kind when 'wfh' then 'Work from home' else 'Outside work' end || ' on '
      || hrms.fmt_day_range(v_row.work_date, null) || ' was cancelled: ' || v_reason
      || '. Check in at the office as usual.',
    '/attendance/day?date=' || v_row.work_date::text, null, null);
  return hrms.ok(jsonb_build_object('id', v_row.id, 'kind', v_row.kind));
end;
$$;

drop function if exists public.list_outside_work(date, integer, date, uuid);
-- p_kind: 'outside' | 'wfh' | null (both). Each row says which it is.
create or replace function public.list_outside_work(
  p_from date default null, p_limit integer default 50,
  p_before_date date default null, p_before_id uuid default null,
  p_kind text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if not hrms.is_hr_or_admin(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if p_kind is not null and p_kind not in ('outside', 'wfh') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown kind.', '{"kind":"Use outside or wfh"}'::jsonb);
  end if;
  return hrms.ok((select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'work_date', x.work_date, 'reason', x.reason, 'kind', x.kind,
      'from_request', x.request_id is not null, 'request_id', x.request_id,
      'employee', jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name))
      order by x.work_date desc, x.id desc), '[]'::jsonb)
    from (select * from hrms.outside_work o
          where o.org_id = v_actor.org_id and o.revoked_at is null
            and (p_kind is null or o.kind = p_kind)
            and o.work_date >= coalesce(p_from, hrms.org_today(v_actor.org_id) - 30)
            and (p_before_date is null or (o.work_date, o.id) < (p_before_date, p_before_id))
          order by o.work_date desc, o.id desc limit v_limit) x
    join hrms.employees e on e.id = x.employee_id));
end;
$$;

-- -----------------------------------------------------------------------------
-- Work from home is its own attendance source ('wfh'), separate from 'outside'.
-- -----------------------------------------------------------------------------
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
  )
  select w.employee_id, w.shift_date, w.id, w.kind, w.is_required, w.timezone, w.start_at, w.end_at,
         w.half_split_at, w.lunch_start_at, w.lunch_end_at, w.lunch_paid, w.grace_seconds, w.expected_seconds,
         w.start_at - make_interval(secs => w.early_entry_seconds),
         w.end_at + make_interval(secs => w.checkout_extension_seconds),
         w.office_id,
         s.id, coalesce(s.state, case when ow.id is not null and p_now >= w.start_at then 'closed' end),
         coalesce(s.effective_in_at, case when ow.id is not null then w.start_at end),
         coalesce(s.effective_out_at, case when ow.id is not null then w.end_at end),
         coalesce(s.effective_source, case when ow.id is not null then (case ow.kind when 'wfh' then 'wfh' else 'outside' end) end),
         coalesce(s.effective_revision, case when ow.id is not null then 0 end),
         coalesce(sl.slots, 0),
         hrms.day_status(w.kind, w.is_required, w.start_at,
                         w.end_at + make_interval(secs => w.checkout_extension_seconds),
                         coalesce(s.state, case when ow.id is not null and p_now >= w.start_at then 'closed' end),
                         coalesce(sl.slots, 0), p_now),
         hrms.calc_day(w.is_required, w.start_at, w.end_at, w.half_split_at, w.expected_seconds,
                       coalesce(sl.slots, 0), w.grace_seconds, w.early_credit, w.checkout_extension_seconds,
                       coalesce(s.effective_in_at, case when ow.id is not null and p_now >= w.start_at then w.start_at end),
                       case when s.state = 'closed' then s.effective_out_at
                            when s.id is null and ow.id is not null and p_now >= w.start_at then w.end_at end)
  from hrms.work_schedule_instances w
  left join hrms.attendance_sessions s on s.schedule_instance_id = w.id
  left join slots sl on sl.employee_id = w.employee_id and sl.day = w.shift_date
  -- Outside work (HR/Admin) or approved work from home: a working day with no
  -- punches counts as the full shift.
  left join hrms.outside_work ow
    on ow.employee_id = w.employee_id and ow.work_date = w.shift_date and ow.revoked_at is null
   and w.kind in ('workday', 'extra_workday') and s.id is null
  where w.org_id = p_org
    and w.employee_id = any(p_employee_ids)
    and w.shift_date between p_from and p_to;
$$;

create or replace function hrms.current_shift(p_actor hrms.actor, p_now timestamptz) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := hrms.org_today(p_actor.org_id);
  v_pick hrms.attendance_row;
  v_in_opens timestamptz;
  v_in_closes timestamptz;
begin
  perform hrms.ensure_schedule_instances(p_actor.org_id, array[p_actor.employee_id], v_today - 1, v_today + 1);
  perform hrms.rollover_stale_sessions(p_actor.employee_id, p_now);

  -- Preference: open session > shift whose check-in window contains now >
  -- today's shift > yesterday's.
  select (x.r).* into v_pick
  from (
    select r, r.shift_date, r.session_state, r.session_id, r.is_required, r.leave_slots,
           (case when r.leave_slots = 1 then r.split_at else r.start_at end)
             - (r.start_at - r.checkin_opens_at) as in_opens,
           case when r.leave_slots = 2 then r.split_at else r.end_at end as in_closes
    from hrms.attendance_rows(p_actor.org_id, array[p_actor.employee_id], v_today - 1, v_today, p_now) r
  ) x
  order by coalesce(x.session_state = 'open', false) desc,
           coalesce(x.session_id is null and x.is_required and x.leave_slots < 3
             and p_now >= x.in_opens and p_now < x.in_closes, false) desc,
           (x.shift_date = v_today) desc,
           x.shift_date desc
  limit 1;

  if not found then
    return null;
  end if;
  v_in_opens := (case when v_pick.leave_slots = 1 then v_pick.split_at else v_pick.start_at end)
                - (v_pick.start_at - v_pick.checkin_opens_at);
  v_in_closes := case when v_pick.leave_slots = 2 then v_pick.split_at else v_pick.end_at end;

  return hrms.attendance_row_json(v_pick) || jsonb_build_object(
    'checkin_opens_at', v_in_opens,
    'checkin_closes_at', v_in_closes,
    'office', (select jsonb_build_object('id', o.id, 'name', o.name, 'radius_m', o.radius_m,
                                         'wifi_ssids', to_jsonb(o.wifi_ssids),
                                         'max_accuracy_m', o.max_accuracy_m,
                                         'max_sample_age_s', o.max_sample_age_s, 'active', o.active,
                                         'latitude', extensions.st_y(o.location::extensions.geometry),
                                         'longitude', extensions.st_x(o.location::extensions.geometry))
               from hrms.offices o where o.id = v_pick.office_id),
    'outside_work', v_pick.effective_source = 'outside',
    'work_from_home', v_pick.effective_source = 'wfh',
    'next_action', case
      when v_pick.effective_source in ('outside', 'wfh') then null
      when v_pick.session_state = 'open' and p_now <= v_pick.checkout_closes_at then 'OUT'
      when v_pick.session_id is null and v_pick.is_required and v_pick.leave_slots < 3
           and p_now >= v_in_opens and p_now < v_in_closes then 'IN'
      else null end,
    'blocked_reason', case
      when v_pick.effective_source = 'outside' then 'outside_work'
      when v_pick.effective_source = 'wfh' then 'work_from_home'
      when v_pick.leave_slots = 3 then 'on_leave'
      when not v_pick.is_required then v_pick.kind
      when v_pick.office_id is null then 'no_office'
      when v_pick.session_id is null and p_now < v_in_opens then 'not_open_yet'
      when v_pick.session_id is null and p_now >= v_in_closes then 'window_closed'
      when v_pick.session_state = 'closed' then 'completed'
      when v_pick.session_state = 'needs_correction' then 'needs_correction'
      else null end);
end;
$$;


do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'hrms' loop
    execute format('alter table hrms.%I enable row level security', r.tablename);
  end loop;
end $$;

select hrms.apply_api_grants();
