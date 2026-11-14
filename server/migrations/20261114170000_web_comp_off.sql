-- [web-hrms] Comp-off for working on a day off (PLAN §7 item 10).
--
-- An employee who worked on a holiday, weekly off or day off asks for
-- comp-off for that day. Any HR/Admin (not the requester) approves it, like
-- late arrival and work from home. Approval credits a "Comp off" leave
-- balance: a full day for 6+ hours worked, half a day for 3+ hours. The
-- credit is valid for 90 days (and within the same leave year, because
-- balances are kept per leave year) and is spent through the normal leave
-- request. Requests must be made within 30 days of the worked day; one per
-- day.

alter table hrms.requests drop constraint requests_kind_check;
alter table hrms.requests add constraint requests_kind_check check (kind in (
  'leave', 'correction', 'bank_details', 'profile_details', 'employee_details',
  'employee_assignment', 'employee_status', 'salary_change', 'payslip_publish',
  'late_excuse', 'wfh', 'comp_off'
));

alter table hrms.leave_allocations drop constraint if exists leave_allocations_source_check;
alter table hrms.leave_allocations add constraint leave_allocations_source_check
  check (source in ('annual', 'prorata', 'carry_forward', 'manual', 'comp_off'));

create or replace function hrms.is_pool_kind(p_kind text) returns boolean
language sql immutable set search_path = '' as $$
  select p_kind in ('leave', 'correction', 'late_excuse', 'wfh', 'comp_off');
$$;

-- Hours actually worked on a day (closed sessions with both punches).
create or replace function hrms.worked_seconds_on(p_employee uuid, p_day date) returns integer
language sql stable set search_path = '' as $$
  select coalesce(sum(extract(epoch from (s.effective_out_at - s.effective_in_at)))::integer, 0)
  from hrms.attendance_sessions s
  where s.employee_id = p_employee and s.shift_date = p_day and s.state = 'closed'
    and s.effective_in_at is not null and s.effective_out_at is not null;
$$;

create or replace function hrms.validate_comp_off(p_actor hrms.actor, p_day date, p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := hrms.org_today(p_actor.org_id);
  v_inst hrms.work_schedule_instances;
  v_worked integer;
begin
  if p_day > v_today then
    return jsonb_build_object('errors', '{"start_date":"Choose a day you have already worked"}'::jsonb);
  end if;
  if p_day < v_today - 30 then
    return jsonb_build_object('errors', '{"start_date":"Ask within 30 days of the day you worked"}'::jsonb);
  end if;
  perform hrms.ensure_schedule_instances(p_actor.org_id, array[p_actor.employee_id], p_day, p_day);
  select * into v_inst from hrms.work_schedule_instances
  where employee_id = p_actor.employee_id and shift_date = p_day;
  if found and v_inst.is_required then
    return jsonb_build_object('errors', '{"start_date":"This was a working day. Comp-off is for working on a holiday or day off"}'::jsonb);
  end if;
  v_worked := hrms.worked_seconds_on(p_actor.employee_id, p_day);
  if v_worked < 3 * 3600 then
    return jsonb_build_object('errors', '{"start_date":"Work at least 3 hours (checked in and out) on the day off to earn comp-off"}'::jsonb);
  end if;
  if exists (select 1 from hrms.requests r where r.employee_id = p_actor.employee_id and r.kind = 'comp_off'
             and r.target_shift_date = p_day and r.id is distinct from p_request_id
             and r.state in ('draft', 'submitted', 'under_review', 'returned', 'approved')) then
    return jsonb_build_object('errors', '{"start_date":"You already asked for comp-off for this day"}'::jsonb);
  end if;
  return jsonb_build_object('errors', '{}'::jsonb, 'days', jsonb_build_array(p_day),
                            'worked_seconds', v_worked,
                            'units', case when v_worked >= 6 * 3600 then 2 else 1 end);
end;
$$;

-- Approval: credit the Comp off balance (the leave type is created on first use).
create or replace function hrms.credit_comp_off(p_req hrms.requests, p_payload jsonb, p_approver uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org hrms.organizations;
  v_day date := (p_payload ->> 'shift_date')::date;
  v_units integer := (p_payload ->> 'units')::integer;
  v_type uuid;
  v_year integer;
  v_acc uuid;
  v_alloc uuid;
  v_until date;
begin
  if v_units not in (1, 2) then perform hrms.raise_error('VALIDATION_FAILED', 'Invalid comp-off amount.'); end if;
  if exists (select 1 from hrms.leave_ledger where request_id = p_req.id and entry_kind = 'allocate') then
    return; -- already credited
  end if;
  select * into v_org from hrms.organizations where id = p_req.org_id;
  insert into hrms.leave_types (org_id, code, name, paid, half_day_allowed, backdate_days)
  values (v_org.id, 'COMP_OFF', 'Comp off', true, true, 0)
  on conflict (org_id, code) do nothing;
  select id into v_type from hrms.leave_types where org_id = v_org.id and code = 'COMP_OFF';
  v_year := hrms.leave_year_of(v_org.leave_year_start_month, v_day);
  v_until := least(v_day + 91, (make_date(v_year, v_org.leave_year_start_month, 1) + interval '1 year')::date);
  if v_until <= hrms.org_today(v_org.id) then
    perform hrms.raise_error('VALIDATION_FAILED', 'This comp-off would already have expired. Approve it as a balance adjustment instead.');
  end if;
  insert into hrms.leave_accounts (org_id, employee_id, leave_type_id, leave_year)
  values (v_org.id, p_req.employee_id, v_type, v_year)
  on conflict (employee_id, leave_type_id, leave_year) do nothing;
  select id into v_acc from hrms.leave_accounts
  where employee_id = p_req.employee_id and leave_type_id = v_type and leave_year = v_year for update;
  insert into hrms.leave_allocations (org_id, account_id, source, valid_from, valid_to, operation_id, reason, created_by)
  values (v_org.id, v_acc, 'comp_off', v_day, v_until, p_req.id, 'Comp-off for working ' || to_char(v_day, 'DD Mon YYYY'), p_approver)
  returning id into v_alloc;
  insert into hrms.leave_ledger (org_id, account_id, allocation_id, entry_kind, units, source_operation_id, request_id, created_by)
  values (v_org.id, v_acc, v_alloc, 'allocate', v_units, p_req.id, p_req.id, p_approver);
end;
$$;

create or replace function hrms.change_category_label(p_kind text) returns text
language sql immutable set search_path = '' as $$
  select case p_kind
    when 'leave' then 'Leave'
    when 'correction' then 'Attendance correction'
    when 'late_excuse' then 'Late arrival'
    when 'wfh' then 'Work from home'
    when 'comp_off' then 'Comp-off'
    when 'profile_details' then 'Profile details'
    when 'employee_details' then 'Employee details'
    when 'employee_assignment' then 'Employee assignment'
    when 'employee_status' then 'Employee status'
    when 'salary_change' then 'Salary change'
    when 'payslip_publish' then 'Payslip publication'
    when 'bank_details' then 'Bank details'
    else 'Request' end;
$$;

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

  if p_kind = 'comp_off' then
    return hrms.validate_comp_off(p_actor, p_from, p_request_id);
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
  elsif p_req.kind = 'comp_off' then
    perform hrms.credit_comp_off(p_req, p_payload, p_approver);
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
  v_end date := case when p_kind in ('late_excuse', 'comp_off') then p_start_date else coalesce(p_end_date, p_start_date) end;
  v_result jsonb;
  v_units integer;
begin
  if p_kind not in ('late_excuse', 'wfh', 'comp_off') then
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
  v_units := case when p_kind = 'comp_off' then (v_check ->> 'units')::integer
                  else jsonb_array_length(v_check -> 'days') end;
  v_payload := case when p_kind = 'comp_off'
    then jsonb_build_object('shift_date', p_start_date, 'reason', v_reason, 'units', v_units,
                            'worked_seconds', v_check -> 'worked_seconds')
    when p_kind = 'late_excuse'
    then jsonb_build_object('shift_date', p_start_date, 'reason', v_reason,
                            'shift_start_at', v_check -> 'shift_start_at')
    else jsonb_build_object('start_date', p_start_date, 'end_date', v_end, 'days', v_check -> 'days',
                            'reason', v_reason) end;

  if p_request_id is null then
    insert into hrms.requests (org_id, employee_id, kind, state, start_date, end_date, units, target_shift_date)
    values (v_actor.org_id, v_actor.employee_id, p_kind, 'draft',
            case when p_kind = 'wfh' then p_start_date end, case when p_kind = 'wfh' then v_end end,
            v_units, case when p_kind in ('late_excuse', 'comp_off') then p_start_date end)
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
           target_shift_date = case when p_kind in ('late_excuse', 'comp_off') then p_start_date end
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
          case when p_kind = 'wfh' then 'Work from home request' when p_kind = 'comp_off' then 'Comp-off request'
               else 'Late arrival request' end,
          (select left(full_name, 90) from hrms.employees where id = v_actor.employee_id)
            || case when p_kind = 'wfh' then ' asked to work from home ' || hrms.fmt_day_range(p_start_date, v_end)
                    when p_kind = 'comp_off' then ' asked for comp-off for working ' || hrms.fmt_day_range(p_start_date, null)
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
    elsif v_req.kind in ('late_excuse', 'wfh', 'comp_off') then
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
         when v_req.kind = 'comp_off' and v_to = 'approved'
           then 'Comp-off for working ' || hrms.fmt_day_range(v_req.target_shift_date, null)
                || ' was added to your leave balance (' || case when v_req.units = 1 then 'half a day' else '1 day' end || ').'
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

select hrms.apply_api_grants();
