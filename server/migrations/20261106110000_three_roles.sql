-- [web-hrms] Ported from ~/Documents/Projects/September/HRMS/hrms/supabase/migrations/20261106110000_three_roles.sql
-- [web-hrms]   unchanged

-- =============================================================================
-- Three roles (owner decision 2026-11-06): Employee, HR, Admin.
--
--   * Employee — no role grant. Carries a display label: Member or Manager.
--   * HR       — fixed bundle: people (add/remove Employees and HR), salaries,
--                payslips, approvals, org reports, policies, announcements,
--                medical documents.
--   * Admin    — everything ('*').
--
-- The old Manager role and the per-person extra permission grants are retired:
-- active grants are revoked (history kept) and Manager becomes a label.
-- HR can never create, promote to, change or remove an Admin.
-- =============================================================================

alter table hrms.employees
  add column position_label text not null default 'member' check (position_label in ('member', 'manager'));

-- Former managers keep the Manager label.
update hrms.employees e set position_label = 'manager'
where exists (select 1 from hrms.role_grants g where g.employee_id = e.id and g.role = 'manager'
                and g.revoked_at is null)
   or exists (select 1 from hrms.team_managers tm where tm.manager_id = e.id
                and (tm.effective_to is null or tm.effective_to > current_date));

update hrms.role_grants
   set revoked_at = greatest(now(), effective_from), reason = coalesce(reason || ' · ', '') || 'Roles simplified: Manager is now a label'
 where role = 'manager' and revoked_at is null;
alter table hrms.role_grants
  add constraint role_grants_three_roles check (role in ('hr', 'admin') or revoked_at is not null);

update hrms.permission_grants
   set revoked_at = greatest(now(), effective_from), reason = coalesce(reason || ' · ', '') || 'Roles simplified: access is set by role'
 where revoked_at is null;
alter table hrms.permission_grants
  add constraint permission_grants_retired check (revoked_at is not null);

-- -----------------------------------------------------------------------------
-- Role bundles: HR is a fixed, complete bundle; nothing else grants access.
-- -----------------------------------------------------------------------------
create or replace function hrms.role_bundle(p_role text) returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'admin' then array['*']
    when 'hr' then array[
      'hr.directory', 'hr.employees.view', 'hr.employees.provision', 'hr.master_data',
      'policy.draft', 'reports.org', 'audit.scoped', 'announcements.publish', 'approvals.review',
      'payroll.manage', 'documents.medical'
    ]
    else array[]::text[]
  end;
$$;

create or replace function hrms.employee_permissions(p_employee uuid) returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(distinct p order by p), array[]::text[])
  from (select unnest(hrms.role_bundle(r)) as p from unnest(hrms.employee_roles(p_employee)) as r) s;
$$;

-- 'admin' | 'hr' | 'employee'
create or replace function hrms.primary_role(p_roles text[]) returns text
language sql immutable set search_path = '' as $$
  select case when 'admin' = any(p_roles) then 'admin' when 'hr' = any(p_roles) then 'hr' else 'employee' end;
$$;

create or replace function hrms.is_hr_or_admin(p_actor hrms.actor) returns boolean
language sql immutable set search_path = '' as $$
  select p_actor.roles && array['hr', 'admin'];
$$;

create or replace function hrms.active_admin_count(p_org uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(distinct g.employee_id)::integer
  from hrms.role_grants g join hrms.employees e on e.id = g.employee_id
  where e.org_id = p_org and e.status = 'active' and g.role = 'admin' and g.revoked_at is null
    and g.effective_from <= now();
$$;

-- -----------------------------------------------------------------------------
-- Session / cards expose the single role and the label.
-- -----------------------------------------------------------------------------
create or replace function public.get_session_context() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor('restricted');
  v_emp hrms.employees;
  v_org hrms.organizations;
begin
  select * into v_emp from hrms.employees where id = v_actor.employee_id;
  select * into v_org from hrms.organizations where id = v_actor.org_id;
  return hrms.ok(jsonb_build_object(
    'employee', jsonb_build_object('id', v_emp.id, 'code', v_emp.employee_code, 'name', v_emp.full_name,
                                   'designation', v_emp.designation, 'position_label', v_emp.position_label),
    'org', jsonb_build_object('id', v_org.id, 'code', v_org.code, 'name', v_org.name, 'timezone', v_org.timezone,
                              'support_contact', v_org.support_contact),
    'role', hrms.primary_role(v_actor.roles),
    'roles', to_jsonb(v_actor.roles),
    'permissions', to_jsonb(v_actor.permissions),
    'must_change_password', v_emp.must_change_password,
    'credential_hold', v_emp.credential_hold_operation_id is not null,
    'permission_version', md5(array_to_string(v_actor.roles, ',') || '|' || array_to_string(v_actor.permissions, ','))
  ));
end;
$$;

create or replace function hrms.employee_card(e hrms.employees, p_day date) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', e.id, 'code', e.employee_code, 'name', e.full_name, 'designation', e.designation,
    'position_label', e.position_label, 'role', hrms.primary_role(hrms.employee_roles(e.id)),
    'department', (select jsonb_build_object('id', d.id, 'name', d.name) from hrms.departments d where d.id = e.department_id),
    'team', (select jsonb_build_object('id', t.id, 'name', t.name) from hrms.team_memberships m
             join hrms.teams t on t.id = m.team_id
             where m.employee_id = e.id and daterange(m.effective_from, m.effective_to, '[)') @> p_day limit 1),
    'avatar_file_version_id', e.avatar_file_version_id,
    'business_email', e.business_email, 'business_phone', e.business_phone);
$$;

-- -----------------------------------------------------------------------------
-- Changing someone's role and label (HR or Admin).
-- -----------------------------------------------------------------------------
create or replace function hrms.role_label(p_role text) returns text
language sql immutable set search_path = '' as $$
  select case p_role when 'admin' then 'Admin' when 'hr' then 'HR' else 'Employee' end;
$$;

create or replace function public.set_employee_access(
  p_employee_id uuid, p_role text, p_label text, p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_emp hrms.employees;
  v_reason text := hrms.clean_text(p_reason, 500);
  v_role text := lower(coalesce(nullif(btrim(p_role), ''), 'employee'));
  v_label text := lower(nullif(btrim(p_label), ''));
  v_current text;
begin
  if not hrms.is_hr_or_admin(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if v_role = 'member' then v_role := 'employee'; end if;
  if v_role not in ('employee', 'hr', 'admin') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose Employee, HR or Admin.', '{"role":"Unknown role"}'::jsonb);
  end if;
  if v_label is not null and v_label not in ('member', 'manager') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose Member or Manager.', '{"label":"Unknown label"}'::jsonb);
  end if;
  if v_reason is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'A reason is required.', '{"reason":"Required"}'::jsonb);
  end if;

  -- Serialise role changes per org (last-Admin rule).
  perform 1 from hrms.organizations where id = v_actor.org_id for update;
  select * into v_emp from hrms.employees where id = p_employee_id and org_id = v_actor.org_id for update;
  if not found or v_emp.status <> 'active' then perform hrms.raise_error('ACCESS_DENIED'); end if;
  v_current := hrms.primary_role(hrms.employee_roles(v_emp.id));

  if not hrms.is_admin(v_actor) and (v_current = 'admin' or v_role = 'admin') then
    perform hrms.raise_error('ACCESS_DENIED', 'Only an Admin can add, change or remove an Admin.');
  end if;
  if v_current = 'admin' and v_role <> 'admin' and hrms.active_admin_count(v_actor.org_id) <= 1 then
    perform hrms.raise_error('VALIDATION_FAILED', 'At least one active Admin must remain.');
  end if;
  if v_emp.id = v_actor.employee_id and v_role <> v_current then
    perform hrms.raise_error('ACCESS_DENIED', 'You cannot change your own role.');
  end if;
  -- Elevation needs a fresh password confirmation.
  if v_role <> v_current and (v_role = 'admin' or (v_role = 'hr' and v_current = 'employee')) then
    perform hrms.require_reauth(v_actor, 'role.elevate', v_emp.id, true);
  end if;

  if v_role <> v_current then
    update hrms.role_grants set revoked_at = greatest(now(), effective_from), revoked_by = v_actor.employee_id,
           reason = coalesce(reason || ' · ', '') || v_reason
     where employee_id = v_emp.id and revoked_at is null and role <> v_role;
    if v_role in ('hr', 'admin') and not exists (
         select 1 from hrms.role_grants where employee_id = v_emp.id and role = v_role and revoked_at is null) then
      insert into hrms.role_grants (org_id, employee_id, role, granted_by, reason)
      values (v_actor.org_id, v_emp.id, v_role, v_actor.employee_id, v_reason);
    end if;
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'role.changed', 'employee', v_emp.id,
      jsonb_build_object('from', v_current, 'to', v_role, 'reason', v_reason), 'security', v_emp.id);
    perform hrms.notify(v_actor.org_id, v_emp.id, 'access.role_changed', 'Your access changed',
      'You now have ' || hrms.role_label(v_role) || ' access in the app.', '/profile', null, null);
  end if;

  if v_label is not null and v_label <> v_emp.position_label then
    update hrms.employees set position_label = v_label, version = version + 1, updated_by = v_actor.employee_id
     where id = v_emp.id;
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'employee.label_changed', 'employee', v_emp.id,
      jsonb_build_object('from', v_emp.position_label, 'to', v_label, 'reason', v_reason), 'business', v_emp.id);
  end if;

  select * into v_emp from hrms.employees where id = v_emp.id;
  return hrms.ok(jsonb_build_object('employee_id', v_emp.id, 'role', hrms.primary_role(hrms.employee_roles(v_emp.id)),
                                    'position_label', v_emp.position_label), v_emp.version);
end;
$$;

-- Kept for older clients and tests: thin wrappers over set_employee_access.
create or replace function public.grant_role(p_employee_id uuid, p_role text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_role not in ('hr', 'admin') then perform hrms.raise_error('VALIDATION_FAILED', 'Unknown role.'); end if;
  perform public.set_employee_access(p_employee_id, p_role, null, p_reason);
  return public.list_access_grants();
end;
$$;

create or replace function public.revoke_role(p_employee_id uuid, p_role text, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_role not in ('hr', 'admin') then perform hrms.raise_error('VALIDATION_FAILED', 'Unknown role.'); end if;
  if p_role = any(hrms.employee_roles(p_employee_id)) then
    perform public.set_employee_access(p_employee_id, 'employee', null, p_reason);
  end if;
  return public.list_access_grants();
end;
$$;

drop function if exists public.set_permission(uuid, text, boolean, text);

-- People and their access (HR and Admin).
create or replace function public.list_access_grants() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
begin
  if not hrms.is_hr_or_admin(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  return hrms.ok((select coalesce(jsonb_agg(jsonb_build_object(
      'employee', jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name, 'status', e.status,
                                     'designation', e.designation, 'position_label', e.position_label),
      'role', hrms.primary_role(hrms.employee_roles(e.id)),
      'roles', to_jsonb(hrms.employee_roles(e.id)),
      'permissions', '[]'::jsonb)
      order by e.full_name, e.id), '[]'::jsonb)
    from hrms.employees e where e.org_id = v_actor.org_id and e.status <> 'pending'));
end;
$$;

-- -----------------------------------------------------------------------------
-- Provisioning: HR may create Employees and HR; only Admin creates Admins.
-- 'manager' / 'member' in the role field become the label (bulk import).
-- -----------------------------------------------------------------------------
create or replace function public.internal_provision_begin(
  p_auth_user_id uuid, p_session_id uuid, p_email text, p_operation_id uuid, p_fields jsonb, p_alias_domain text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.resolve_actor(p_auth_user_id, p_session_id, p_email, 'business');
  v_org hrms.organizations;
  v_emp hrms.employees;
  v_code text := hrms.normalize_employee_code(p_fields ->> 'employee_code');
  v_role text := lower(nullif(btrim(p_fields ->> 'role'), ''));
  v_label text := lower(coalesce(nullif(btrim(p_fields ->> 'position_label'), ''), 'member'));
  v_join date;
  v_errors jsonb := '{}'::jsonb;
  v_active integer;
  v_team uuid := nullif(p_fields ->> 'team_id', '')::uuid;
  v_office uuid := nullif(p_fields ->> 'office_id', '')::uuid;
  v_shift uuid := nullif(p_fields ->> 'shift_id', '')::uuid;
  v_dept uuid := nullif(p_fields ->> 'department_id', '')::uuid;
  v_name text := hrms.clean_text(p_fields ->> 'full_name', 200);
begin
  if not (hrms.is_admin(v_actor) or hrms.has_perm(v_actor, 'hr.employees.provision')) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  if v_role in ('member', 'employee') then v_role := null; end if;
  if v_role = 'manager' then v_role := null; v_label := 'manager'; end if;
  if v_role is not null and v_role not in ('hr', 'admin') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown role.', '{"role":"Choose Employee, HR or Admin"}'::jsonb);
  end if;
  if v_label not in ('member', 'manager') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown label.', '{"position_label":"Choose Member or Manager"}'::jsonb);
  end if;
  if v_role = 'admin' and not hrms.is_admin(v_actor) then
    perform hrms.raise_error('ACCESS_DENIED', 'Only an Admin can create Admin accounts.');
  end if;

  select * into v_emp from hrms.employees where provisioning_operation_id = p_operation_id;
  if found then
    if v_emp.org_id <> v_actor.org_id then perform hrms.raise_error('ACCESS_DENIED'); end if;
    return jsonb_build_object('employee_id', v_emp.id, 'auth_alias', v_emp.auth_alias,
      'provisioning_state', v_emp.provisioning_state, 'auth_user_id', v_emp.auth_user_id, 'resumed', true);
  end if;

  -- Serialise provisioning per org so the active-employee cap is exact.
  select * into v_org from hrms.organizations where id = v_actor.org_id for update;

  if v_code is null then v_errors := v_errors || '{"employee_code":"3–32 letters, digits or -"}'; end if;
  if v_name is null then v_errors := v_errors || '{"full_name":"Required"}'; end if;
  begin
    v_join := (p_fields ->> 'join_date')::date;
  exception when others then v_join := null;
  end;
  if v_join is null then v_errors := v_errors || '{"join_date":"Required"}'; end if;
  if v_team is null or not exists (select 1 from hrms.teams where id = v_team and org_id = v_org.id and active) then
    v_errors := v_errors || '{"team_id":"Choose a team"}';
  end if;
  if v_office is null or not exists (select 1 from hrms.offices where id = v_office and org_id = v_org.id) then
    v_errors := v_errors || '{"office_id":"Choose an office"}';
  end if;
  if v_shift is null or not exists (select 1 from hrms.shifts where id = v_shift and org_id = v_org.id and active) then
    v_errors := v_errors || '{"shift_id":"Choose a shift"}';
  end if;
  if v_dept is not null and not exists (select 1 from hrms.departments where id = v_dept and org_id = v_org.id) then
    v_errors := v_errors || '{"department_id":"Unknown department"}';
  end if;
  if v_code is not null and exists (select 1 from hrms.employees where org_id = v_org.id and employee_code = v_code) then
    v_errors := v_errors || '{"employee_code":"This employee ID already exists"}';
  end if;
  if v_errors <> '{}'::jsonb then
    perform hrms.raise_error('VALIDATION_FAILED', 'Please check the highlighted fields.', v_errors);
  end if;

  select count(*) into v_active from hrms.employees
  where org_id = v_org.id and (status = 'active' or (status = 'pending' and provisioning_state <> 'complete'));
  if v_active >= v_org.active_employee_cap then
    perform hrms.raise_error('ACTIVE_EMPLOYEE_CAP_REACHED',
      format('The active employee limit (%s) is reached. An Admin can review the limit.', v_org.active_employee_cap));
  end if;

  insert into hrms.employees (org_id, employee_code, full_name, designation, department_id, business_email,
    business_phone, join_date, status, provisioning_state, provisioning_operation_id, auth_alias,
    must_change_password, created_by, updated_by, position_label)
  values (v_org.id, v_code, v_name, hrms.clean_text(p_fields ->> 'designation', 120), v_dept,
    hrms.clean_text(p_fields ->> 'business_email', 200), hrms.clean_text(p_fields ->> 'business_phone', 40),
    v_join, 'pending', 'pending', p_operation_id,
    'e-' || encode(extensions.gen_random_bytes(12), 'hex') || '@' || coalesce(nullif(p_alias_domain, ''), 'staff.hrms.invalid'),
    true, v_actor.employee_id, v_actor.employee_id, v_label)
  returning * into v_emp;

  insert into hrms.employee_private_details (employee_id, org_id) values (v_emp.id, v_org.id);
  insert into hrms.team_memberships (org_id, employee_id, team_id, effective_from, created_by, reason)
  values (v_org.id, v_emp.id, v_team, v_join, v_actor.employee_id, 'Provisioned');
  insert into hrms.office_assignments (org_id, employee_id, office_id, effective_from, created_by, reason)
  values (v_org.id, v_emp.id, v_office, v_join, v_actor.employee_id, 'Provisioned');
  insert into hrms.shift_assignments (org_id, employee_id, shift_id, effective_from, created_by, reason)
  values (v_org.id, v_emp.id, v_shift, v_join, v_actor.employee_id, 'Provisioned');
  if v_role is not null then
    insert into hrms.role_grants (org_id, employee_id, role, granted_by, reason)
    values (v_org.id, v_emp.id, v_role, v_actor.employee_id, 'Provisioned');
  end if;
  insert into hrms.credential_operations (org_id, employee_id, operation_id, kind, issued_by)
  values (v_org.id, v_emp.id, p_operation_id, 'provision', v_actor.employee_id);

  perform hrms.audit(v_org.id, v_actor.employee_id, 'employee.provision_started', 'employee', v_emp.id,
    jsonb_build_object('employee_code', v_code, 'role', coalesce(v_role, 'employee'), 'label', v_label,
                       'team_id', v_team),
    'security', v_emp.id);
  return jsonb_build_object('employee_id', v_emp.id, 'auth_alias', v_emp.auth_alias,
    'provisioning_state', v_emp.provisioning_state, 'auth_user_id', null, 'resumed', false);
end;
$$;

-- -----------------------------------------------------------------------------
-- Remove from organisation / restore: HR may act on Employees and HR, never on
-- an Admin. History is kept; login and push are revoked.
-- -----------------------------------------------------------------------------
create or replace function public.set_employee_status(
  p_employee_id uuid, p_status text, p_end_date date, p_reason text, p_expected_version integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_emp hrms.employees;
  v_org hrms.organizations;
  v_reason text := hrms.clean_text(p_reason, 500);
  v_active integer;
  v_pending jsonb;
begin
  if not hrms.can_master_data(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if p_status not in ('active', 'inactive') or v_reason is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose a status and give a reason.', '{"reason":"Required"}'::jsonb);
  end if;
  select * into v_org from hrms.organizations where id = v_actor.org_id for update;
  select * into v_emp from hrms.employees where id = p_employee_id and org_id = v_org.id for update;
  if not found or v_emp.id = v_actor.employee_id then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if v_emp.version <> p_expected_version then
    perform hrms.raise_error('STALE_VERSION', 'This profile changed. Reload and try again.', null, true);
  end if;
  if 'admin' = any(hrms.employee_roles(v_emp.id)) and not hrms.is_admin(v_actor) then
    perform hrms.raise_error('ACCESS_DENIED', 'Only an Admin can remove or restore an Admin.');
  end if;
  if p_status = 'inactive' then
    if 'admin' = any(hrms.employee_roles(v_emp.id)) and hrms.active_admin_count(v_org.id) <= 1 then
      perform hrms.raise_error('VALIDATION_FAILED', 'At least one active Admin must remain.');
    end if;
    update hrms.employees set status = 'inactive', end_date = coalesce(p_end_date, hrms.org_today(v_org.id)),
           credentials_valid_after = clock_timestamp(), version = version + 1, updated_by = v_actor.employee_id
    where id = v_emp.id returning * into v_emp;
    update hrms.push_tokens set revoked_at = now() where employee_id = v_emp.id and revoked_at is null;
    select coalesce(jsonb_agg(hrms.request_summary(r)), '[]'::jsonb) into v_pending
    from hrms.requests r where r.assigned_reviewer_id = v_emp.id
      and r.state in ('submitted', 'under_review', 'withdrawal_pending', 'cancellation_pending');
  else
    select count(*) into v_active from hrms.employees where org_id = v_org.id and status = 'active';
    if v_active >= v_org.active_employee_cap then
      perform hrms.raise_error('ACTIVE_EMPLOYEE_CAP_REACHED', 'The active employee limit is reached.');
    end if;
    if v_emp.provisioning_state <> 'complete' then
      perform hrms.raise_error('VALIDATION_FAILED', 'Finish account setup first.');
    end if;
    update hrms.employees set status = 'active', end_date = null, version = version + 1,
           updated_by = v_actor.employee_id
    where id = v_emp.id returning * into v_emp;
  end if;
  perform hrms.audit(v_org.id, v_actor.employee_id, 'employee.status_' || p_status, 'employee', v_emp.id,
    jsonb_build_object('reason', v_reason, 'end_date', v_emp.end_date), 'security', v_emp.id);
  return hrms.ok(jsonb_build_object('employee_id', v_emp.id, 'status', v_emp.status, 'end_date', v_emp.end_date,
    'pending_reviews_to_reassign', coalesce(v_pending, '[]'::jsonb)), v_emp.version);
end;
$$;

-- -----------------------------------------------------------------------------
-- Team managers no longer imply a role; they are given the Manager label.
-- -----------------------------------------------------------------------------
create or replace function public.set_team_manager(p_team_id uuid, p_manager_id uuid, p_effective_from date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_from date := coalesce(p_effective_from, hrms.org_today(v_actor.org_id));
begin
  if not hrms.can_master_data(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if not exists (select 1 from hrms.teams where id = p_team_id and org_id = v_actor.org_id) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  if p_manager_id is not null and not exists (
       select 1 from hrms.employees where id = p_manager_id and org_id = v_actor.org_id and status = 'active') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose an active employee.', '{"manager_id":"Not active"}'::jsonb);
  end if;
  if p_manager_id is not null and hrms.team_on(p_manager_id, v_from) = p_team_id then
    perform hrms.raise_error('VALIDATION_FAILED',
      'A manager cannot be a member of the team they manage. Place them in a parent team first.',
      '{"manager_id":"Member of this team"}'::jsonb);
  end if;
  delete from hrms.team_managers where team_id = p_team_id and effective_from >= v_from;
  update hrms.team_managers set effective_to = v_from
  where team_id = p_team_id and effective_from < v_from and (effective_to is null or effective_to > v_from);
  if p_manager_id is not null then
    insert into hrms.team_managers (org_id, team_id, manager_id, effective_from, created_by, reason)
    values (v_actor.org_id, p_team_id, p_manager_id, v_from, v_actor.employee_id, hrms.clean_text(p_reason, 500));
    update hrms.employees set position_label = 'manager', version = version + 1
     where id = p_manager_id and position_label <> 'manager';
  end if;
  perform hrms.assert_no_reporting_cycle(v_actor.org_id, v_from);
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'team.manager_set', 'team', p_team_id,
    jsonb_build_object('manager_id', p_manager_id, 'effective_from', v_from, 'reason', p_reason), 'business',
    p_manager_id);
  return public.list_org_structure();
end;
$$;

-- -----------------------------------------------------------------------------
-- Scopes: reports and other people's attendance are HR/Admin only.
-- -----------------------------------------------------------------------------
create or replace function hrms.report_scope(p_actor hrms.actor, p_from date, p_to date)
returns table (employee_id uuid, window_from date, window_to date)
language sql
stable
security definer
set search_path = ''
as $$
  select e.id, greatest(p_from, e.join_date), least(p_to, coalesce(e.end_date, p_to))
  from hrms.employees e
  where hrms.has_perm(p_actor, 'reports.org') and e.org_id = p_actor.org_id and e.status <> 'pending'
    and e.id <> p_actor.employee_id;
$$;

create or replace function hrms.can_view_attendance(p_actor hrms.actor, p_employee uuid, p_day date) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_employee = p_actor.employee_id
      or (hrms.has_perm(p_actor, 'reports.org')
          and exists (select 1 from hrms.employees e where e.id = p_employee and e.org_id = p_actor.org_id));
$$;

create or replace function hrms.is_eligible_reviewer(p_reviewer uuid, p_requester uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select hrms.is_hr_admin_reviewer(p_reviewer, p_requester);
$$;

create or replace function public.list_reviewer_candidates() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
begin
  if not hrms.is_hr_or_admin(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  return hrms.ok((select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name,
      'roles', to_jsonb(hrms.employee_roles(e.id))) order by e.full_name), '[]'::jsonb)
    from hrms.employees e where e.org_id = v_actor.org_id and e.status = 'active'
      and hrms.employee_roles(e.id) && array['hr', 'admin']));
end;
$$;

select hrms.apply_api_grants();
