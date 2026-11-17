-- The earlier category migration only seeded organisations that existed then.
-- Bootstrap runs after migrations, so later organisations had no selectable types.
-- Seed only entirely unconfigured organisations; existing types (including inactive
-- ones) and entitlements remain the Admin's decisions.

create or replace function hrms.seed_initial_leave_types(p_org_id uuid) returns void
language sql
security definer
set search_path = ''
as $$
  insert into hrms.leave_types (org_id, code, name, paid, half_day_allowed,
                                requires_attachment, attachment_class, backdate_days)
  select p_org_id, t.code, t.name, t.paid, true,
         t.requires_attachment, t.attachment_class, t.backdate_days
  from (values
    ('PL', 'Paid leave', true, false, 'general', 7),
    ('ML', 'Medical leave', true, true, 'medical', 14),
    ('UL', 'Unpaid leave', false, false, 'general', 7)
  ) as t(code, name, paid, requires_attachment, attachment_class, backdate_days)
  where not exists (select 1 from hrms.leave_types lt where lt.org_id = p_org_id)
  on conflict (org_id, code) do nothing;
$$;

revoke all on function hrms.seed_initial_leave_types(uuid) from public, anon, authenticated;

-- Repair existing empty setups without inventing paid allowances or changing
-- custom leave types. Repeating the helper is a no-op once any types exist.
select hrms.seed_initial_leave_types(o.id)
from hrms.organizations o
where not exists (select 1 from hrms.leave_types lt where lt.org_id = o.id);

-- Also seed future bootstraps, including before the existing-admin early return.
create or replace function hrms.bootstrap_org_admin(
  p_org_code text, p_org_name text, p_timezone text, p_admin_code text, p_admin_name text, p_alias_domain text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org hrms.organizations;
  v_emp hrms.employees;
  v_dept uuid;
  v_team uuid;
  v_shift uuid;
  v_code text := hrms.normalize_employee_code(p_admin_code);
begin
  if v_code is null then raise exception 'HRMS_BOOTSTRAP_ADMIN_CODE must be 3–32 letters, digits or -'; end if;
  if not hrms.valid_timezone(p_timezone) then raise exception 'Unknown time zone %', p_timezone; end if;

  select * into v_org from hrms.organizations where code = upper(btrim(p_org_code));
  if not found then
    insert into hrms.organizations (code, name, timezone)
    values (upper(btrim(p_org_code)), coalesce(hrms.clean_text(p_org_name, 120), 'Internal HRMS'), p_timezone)
    returning * into v_org;
    insert into hrms.departments (org_id, name) values (v_org.id, 'General') returning id into v_dept;
    insert into hrms.teams (org_id, department_id, name) values (v_org.id, v_dept, 'Management') returning id into v_team;
    insert into hrms.shifts (org_id, name) values (v_org.id, 'General') returning id into v_shift;
    -- D07 initial DRAFT: 10:00–19:00, 9 h incl. paid lunch (interval unset),
    -- 30 min grace, 30 min early entry, 120 min checkout extension, Mon–Fri.
    insert into hrms.shift_versions (org_id, shift_id, version_no, effective_from, start_local, end_local, weekly_mask,
      grace_seconds, lunch_paid, early_entry_seconds, checkout_extension_enabled, checkout_extension_seconds, state)
    values (v_org.id, v_shift, 1, hrms.org_today(v_org.id), '10:00', '19:00', 31, 1800, true, 1800, true, 7200, 'draft');
    insert into hrms.storage_ledger (org_id) values (v_org.id);
  end if;

  perform hrms.seed_initial_leave_types(v_org.id);

  select * into v_emp from hrms.employees where org_id = v_org.id and employee_code = v_code;
  if found then
    return jsonb_build_object('org_id', v_org.id, 'employee_id', v_emp.id, 'auth_alias', v_emp.auth_alias,
                              'linked', v_emp.auth_user_id is not null);
  end if;
  if exists (select 1 from hrms.role_grants g join hrms.employees e on e.id = g.employee_id
             where e.org_id = v_org.id and g.role = 'admin' and g.revoked_at is null) then
    raise exception 'This organisation already has an Admin. Add people from the app.';
  end if;

  insert into hrms.employees (org_id, employee_code, full_name, designation, join_date, status, provisioning_state,
                              auth_alias, must_change_password)
  values (v_org.id, v_code, coalesce(hrms.clean_text(p_admin_name, 200), 'Administrator'), 'Administrator',
          hrms.org_today(v_org.id), 'pending', 'pending',
          'e-' || encode(extensions.gen_random_bytes(12), 'hex') || '@' || coalesce(nullif(p_alias_domain, ''), 'staff.hrms.invalid'),
          true)
  returning * into v_emp;
  insert into hrms.employee_private_details (employee_id, org_id) values (v_emp.id, v_org.id);
  insert into hrms.team_memberships (org_id, employee_id, team_id, effective_from, reason)
  select v_org.id, v_emp.id, t.id, v_emp.join_date, 'Bootstrap owner' from hrms.teams t
  where t.org_id = v_org.id and t.name = 'Management';
  insert into hrms.shift_assignments (org_id, employee_id, shift_id, effective_from, reason)
  select v_org.id, v_emp.id, s.id, v_emp.join_date, 'Bootstrap owner' from hrms.shifts s
  where s.org_id = v_org.id and s.name = 'General';
  insert into hrms.role_grants (org_id, employee_id, role, reason)
  values (v_org.id, v_emp.id, 'admin', 'Bootstrap owner');
  perform hrms.audit(v_org.id, null, 'org.bootstrapped', 'employee', v_emp.id,
    jsonb_build_object('employee_code', v_code), 'security', v_emp.id);
  return jsonb_build_object('org_id', v_org.id, 'employee_id', v_emp.id, 'auth_alias', v_emp.auth_alias, 'linked', false);
end;
$$;
