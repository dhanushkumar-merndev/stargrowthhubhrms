create or replace function public.list_employees(
  p_search text default null, p_status text default 'active', p_team_id uuid default null,
  p_department_id uuid default null, p_limit integer default 25, p_offset integer default 0
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_today date := hrms.org_today(v_actor.org_id);
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_term text := nullif(btrim(coalesce(p_search, '')), '');
  v_rows jsonb;
  v_total integer;
  v_org hrms.organizations;
begin
  if not hrms.can_view_hr(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  select * into v_org from hrms.organizations where id = v_actor.org_id;
  with filtered as (
    select e.* from hrms.employees e
    where e.org_id = v_actor.org_id
      and (p_status is null or p_status = 'all' or e.status = p_status
        or (p_status = 'setup_pending' and (
          (e.status = 'pending' and e.provisioning_state <> 'complete')
          or (e.status = 'active' and e.must_change_password)
        )))
      and (p_department_id is null or e.department_id = p_department_id)
      and (p_team_id is null or hrms.team_on(e.id, v_today) = p_team_id)
      and (v_term is null
           or e.employee_code like upper(hrms.like_escape(v_term)) || '%'
           or lower(e.full_name) like lower(hrms.like_escape(v_term)) || '%'
           or lower(e.full_name) like '% ' || lower(hrms.like_escape(v_term)) || '%')
  )
  select (select count(*) from filtered),
         (select coalesce(jsonb_agg(hrms.employee_card(f, v_today) || jsonb_build_object(
                    'status', f.status, 'join_date', f.join_date, 'end_date', f.end_date,
                    'roles', to_jsonb(hrms.employee_roles(f.id)),
                    'setup_pending', f.must_change_password or f.provisioning_state <> 'complete',
                    'version', f.version) order by f.full_name, f.id), '[]'::jsonb)
          from (select * from filtered order by full_name, id limit v_limit offset v_offset) f)
    into v_total, v_rows;
  return hrms.ok(jsonb_build_object('rows', v_rows, 'total', v_total, 'limit', v_limit, 'offset', v_offset,
    'active_count', (select count(*) from hrms.employees where org_id = v_org.id and status = 'active'),
    'active_cap', v_org.active_employee_cap));
end;
$$;

-- Keep the employee row locked until the server writes the password hash and
-- links the account. Repeated or concurrent attempts see the completed record.
create function public.internal_lock_account_provisioning(
  p_auth_user_id uuid, p_session_id uuid, p_email text, p_employee_id uuid, p_operation_id uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.resolve_actor(p_auth_user_id, p_session_id, p_email, 'business');
  v_emp hrms.employees;
  v_roles text[];
begin
  if not hrms.has_perm(v_actor, 'hr.employees.provision') then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  perform 1 from hrms.organizations where id = v_actor.org_id for update;
  select * into v_emp from hrms.employees where id = p_employee_id and org_id = v_actor.org_id for update;
  if not found or v_emp.id = v_actor.employee_id then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if p_operation_id is not null and p_operation_id is distinct from v_emp.provisioning_operation_id then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;

  v_roles := hrms.employee_roles(v_emp.id);
  if not hrms.is_admin(v_actor) and (
    'admin' = any(v_roles) or ('hr' = any(v_roles) and (p_operation_id is null or v_emp.created_by is distinct from v_actor.employee_id))
  ) then
    perform hrms.raise_error('ACCESS_DENIED', 'Only an Admin can finish setup for this account.');
  end if;

  if v_emp.provisioning_state = 'complete' and (v_emp.status = 'active' or p_operation_id is not null) then
    return jsonb_build_object('employee_code', v_emp.employee_code, 'already', true);
  end if;
  if v_emp.status <> 'pending' or v_emp.provisioning_state = 'complete'
    or v_emp.auth_alias is null or v_emp.provisioning_operation_id is null then
    perform hrms.raise_error('CONFLICT', 'This account cannot be activated from pending setup.');
  end if;
  if p_operation_id is null and 'admin' = any(v_roles) then
    perform hrms.require_reauth(v_actor, 'credentials.reset_admin', v_emp.id, true);
  end if;

  return jsonb_build_object('employee_code', v_emp.employee_code, 'auth_alias', v_emp.auth_alias,
    'operation_id', v_emp.provisioning_operation_id, 'already', false);
end;
$$;

select hrms.apply_api_grants();
