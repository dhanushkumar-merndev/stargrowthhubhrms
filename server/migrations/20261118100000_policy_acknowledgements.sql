create table hrms.policy_acknowledgements (
  employee_id uuid primary key,
  org_id uuid not null,
  accepted_at timestamptz not null default now(),
  review jsonb not null,
  foreign key (org_id, employee_id) references hrms.employees(org_id, id) on delete restrict
);
alter table hrms.policy_acknowledgements enable row level security;

-- Reuse the same published policy list the employee sees in Documents.
create function hrms.company_policy_review() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'rules', jsonb_build_array(
      'On scheduled office days, report to your assigned office by the start of your shift and follow your assigned working hours. Follow any approved changes to your schedule or work location.',
      'Record your arrival and departure using your assigned attendance method. Use HRMS to request a correction if a punch is missing or incorrect.',
      'Use HRMS to request leave and follow the company''s published attendance and leave policies.'
    ),
    'documents', coalesce((
      select jsonb_agg(d - 'can_edit' order by d ->> 'published_at' desc, d ->> 'file_version_id')
      from jsonb_array_elements(public.list_my_documents() -> 'data' -> 'company') d
    ), '[]'::jsonb)
  );
$$;

create function public.get_company_policy_review() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_review jsonb := hrms.company_policy_review();
begin
  return hrms.ok(v_review || jsonb_build_object('revision', hrms.sha256_hex(v_review::text)));
end;
$$;

create function public.acknowledge_company_policies(p_revision text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_review jsonb;
  v_accepted_at timestamptz;
begin
  select accepted_at into v_accepted_at
  from hrms.policy_acknowledgements where employee_id = v_actor.employee_id;
  if found then
    return hrms.ok(jsonb_build_object('accepted_at', v_accepted_at));
  end if;

  v_review := hrms.company_policy_review();
  if p_revision is distinct from hrms.sha256_hex(v_review::text) then
    perform hrms.raise_error('STALE_VERSION', 'Company policies changed. Review the latest policies to continue.');
  end if;

  insert into hrms.policy_acknowledgements (employee_id, org_id, review)
  values (v_actor.employee_id, v_actor.org_id, v_review)
  on conflict (employee_id) do nothing
  returning accepted_at into v_accepted_at;
  if found then
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'policy.acknowledged', 'employee', v_actor.employee_id,
                       jsonb_build_object('revision', p_revision), 'business', v_actor.employee_id);
  else
    select accepted_at into v_accepted_at
    from hrms.policy_acknowledgements where employee_id = v_actor.employee_id;
  end if;

  return hrms.ok(jsonb_build_object('accepted_at', v_accepted_at));
end;
$$;

create or replace function public.get_session_context() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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
    'policy_acknowledged_at', (select accepted_at from hrms.policy_acknowledgements where employee_id = v_emp.id),
    'permission_version', md5(array_to_string(v_actor.roles, ',') || '|' || array_to_string(v_actor.permissions, ','))
  ));
end;
$$;

select hrms.apply_api_grants();
