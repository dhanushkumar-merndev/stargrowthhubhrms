-- [web-hrms] Automatic IDs and machine PINs (owner request, 2026-11-16).
--
-- * Employee IDs are generated when HR leaves the field out: EMP0001 for
--   employees, HR0001 for HR, ADM0001 for Admins. Numbers never go back down
--   and a typed ID (import, bootstrap) still works.
-- * Machine PINs are already automatic (hrms.device_employee_changed in
--   20261113100000_web_device_bridge.sql); the API tests now cover it.
-- * "Fetch people from machines": a new read-only machine command
--   (DATA QUERY USERINFO) plus an oplog rewind so the machine uploads its whole
--   user list; the people then show under "New from machine".

-- ------------------------------------------------------------- employee IDs

create or replace function hrms.employee_code_prefix(p_role text) returns text
language sql immutable set search_path = '' as $$
  select case lower(coalesce(p_role, '')) when 'admin' then 'ADM' when 'hr' then 'HR' else 'EMP' end;
$$;

-- Next free code for the role's prefix. Caller holds the organisation row lock.
create or replace function hrms.next_employee_code(p_org uuid, p_role text) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_prefix text := hrms.employee_code_prefix(p_role);
  v_n bigint;
begin
  select coalesce(max(substring(employee_code from char_length(v_prefix) + 1)::bigint), 0) + 1 into v_n
  from hrms.employees
  where org_id = p_org and employee_code ~ ('^' || v_prefix || '[0-9]{1,12}$');
  return v_prefix || lpad(v_n::text, 4, '0');
end;
$$;

-- Preview for the "Add employee" form (the real number is taken on save).
create or replace function public.preview_employee_code(p_role text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
begin
  if not (hrms.is_admin(v_actor) or hrms.has_perm(v_actor, 'hr.employees.provision')) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  return hrms.ok(jsonb_build_object('employee_code',
    hrms.next_employee_code(v_actor.org_id, case when lower(coalesce(p_role, '')) in ('hr', 'admin') then lower(p_role) end)));
end;
$$;

-- Provisioning: same as 20261106110000_three_roles.sql, plus the generated ID.
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
  -- [web-hrms] IDs are generated: EMP0001 / HR0001 / ADM0001 (per role).
  -- A typed ID is still accepted for imports and the bootstrap.
  if nullif(btrim(coalesce(p_fields ->> 'employee_code', '')), '') is null then
    v_code := hrms.next_employee_code(v_org.id, v_role);
  end if;

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

-- ------------------------------------------------ fetch people from machines

alter table hrms.device_commands drop constraint device_commands_kind_check;
alter table hrms.device_commands add constraint device_commands_kind_check
  check (kind in ('user_upsert', 'user_delete', 'enroll_fingerprint', 'enroll_face', 'user_query'));
alter table hrms.device_commands drop constraint device_commands_reason_check;
alter table hrms.device_commands add constraint device_commands_reason_check
  check (reason in ('assign_pin', 'sync', 'employee_changed', 'enroll', 'remove', 'fetch_users'));
alter table hrms.device_commands drop constraint device_commands_check;
alter table hrms.device_commands add constraint device_commands_check
  check (case kind
    when 'user_upsert' then
      jsonb_typeof(payload -> 'name') = 'string'
      and char_length(payload ->> 'name') between 1 and 24
      and (payload ->> 'name') !~ '[[:cntrl:]]'
      and (payload ->> 'privilege') in ('0', '14')
    when 'user_delete' then payload = '{}'::jsonb
    when 'enroll_fingerprint' then
      (payload ->> 'finger') ~ '^[0-9]$' and (payload ->> 'overwrite') in ('0', '1')
    when 'enroll_face' then
      (payload ->> 'face_type') in ('9', '2') and (payload ->> 'overwrite') in ('0', '1')
    when 'user_query' then payload = '{}'::jsonb and pin = '0'
    else false end);

create or replace function hrms.device_command_line(c hrms.device_commands) returns text
language sql
immutable
set search_path = ''
as $$
  select 'C:' || c.id::text || ':' || case c.kind
    when 'user_upsert' then
      'DATA UPDATE USERINFO PIN=' || c.pin || E'\tName=' || (c.payload ->> 'name') || E'\tPri=' || (c.payload ->> 'privilege')
    when 'user_delete' then
      'DATA DELETE USERINFO PIN=' || c.pin
    when 'enroll_fingerprint' then
      'ENROLL_FP PIN=' || c.pin || E'\tFID=' || (c.payload ->> 'finger') || E'\tRETRY=3\tOVERWRITE=' || (c.payload ->> 'overwrite')
    when 'enroll_face' then
      'ENROLL_BIO TYPE=' || (c.payload ->> 'face_type') || E'\tPIN=' || c.pin || E'\tRETRY=3\tOVERWRITE=' || (c.payload ->> 'overwrite')
    when 'user_query' then
      'DATA QUERY USERINFO'
  end;
$$;

-- HR/Admin: ask every active machine (or one) to upload its user list. The
-- oplog cursor is rewound so the next handshake also re-sends USER records;
-- machines with commands on also get DATA QUERY USERINFO.
create or replace function public.fetch_device_users(p_device_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  r hrms.attendance_devices;
  v_machines integer := 0;
  v_queued integer := 0;
begin
  for r in
    select * from hrms.attendance_devices
    where org_id = v_actor.org_id and active and (p_device_id is null or id = p_device_id)
    for update
  loop
    v_machines := v_machines + 1;
    update hrms.attendance_devices set oplog_stamp = 0 where id = r.id;
    if r.commands_enabled and not exists (
         select 1 from hrms.device_commands
         where serial = r.serial and kind = 'user_query' and status in ('queued', 'sent')) then
      perform hrms.device_queue(v_actor.org_id, r.serial, 'user_query', '0', null, '{}'::jsonb, 'fetch_users', v_actor.employee_id);
      v_queued := v_queued + 1;
    end if;
  end loop;
  if p_device_id is not null and v_machines = 0 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose an active machine.', '{"device_id":"invalid"}'::jsonb);
  end if;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device.fetch_users', 'organization', v_actor.org_id,
    jsonb_build_object('machines', v_machines, 'queued', v_queued), 'business', null);
  return hrms.ok(jsonb_build_object('machines', v_machines, 'queued', v_queued));
end;
$$;

-- People on the machines who are not linked to anyone yet ("New from machine").
-- A PIN linked for every machine, or for this machine, counts as linked.
create or replace function public.list_machine_people() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
begin
  return hrms.ok(coalesce((
    select jsonb_agg(jsonb_build_object(
             'serial', u.serial, 'pin', u.pin, 'name', u.name, 'is_device_admin', u.is_device_admin,
             'device_label', d.label, 'last_reported_at', u.last_reported_at,
             'punches', (select count(*) from hrms.device_punch_events p
                         where p.org_id = u.org_id and p.serial = u.serial and p.pin = u.pin))
           order by d.label nulls last, u.serial, length(u.pin), u.pin)
    from hrms.device_users u
    join hrms.attendance_devices d on d.serial = u.serial and d.org_id = u.org_id
    where u.org_id = v_actor.org_id
      and not exists (select 1 from hrms.device_user_links l
                      where l.org_id = u.org_id and l.pin = u.pin and l.unlinked_at is null
                        and (l.serial is null or l.serial = u.serial))), '[]'::jsonb));
end;
$$;

select hrms.apply_api_grants();
