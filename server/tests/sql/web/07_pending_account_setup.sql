begin;
select test.standard_org();

create function pg_temp.stage_account(p_code text, p_role text) returns uuid
language sql as $$
  select (public.internal_provision_begin(p.auth_user_id, p.session_id, p.alias, gen_random_uuid(),
    jsonb_build_object('employee_code', p_code, 'full_name', p_code, 'join_date', current_date, 'role', p_role,
      'team_id', (select id from hrms.teams where org_id = p.org_id and name = 'Team1'),
      'office_id', (select id from hrms.offices where org_id = p.org_id and name = 'O1'),
      'shift_id', (select id from hrms.shifts where org_id = p.org_id and name = 'General')), 'staff.hrms.invalid') ->> 'employee_id')::uuid
  from test.people p where p.code = 'ADMIN01'
$$;

create temporary table staged_accounts (code text, id uuid);
insert into staged_accounts values ('EMP100', pg_temp.stage_account('EMP100', 'employee')),
  ('HR100', pg_temp.stage_account('HR100', 'hr')), ('ADM100', pg_temp.stage_account('ADM100', 'admin'));
grant select on staged_accounts to authenticated, service_role;

create function pg_temp.lock_setup(p_actor text, p_employee_id uuid, p_operation_id uuid default null) returns jsonb
language sql as $$
  select public.internal_lock_account_provisioning(auth_user_id, session_id, alias, p_employee_id, p_operation_id)
  from test.people where code = p_actor
$$;

update hrms.employees set must_change_password = true where id in (test.emp('EMP02'), test.emp('EMP03'), test.emp('EMP09'));
update hrms.employees set status = 'inactive' where id = test.emp('EMP03');

select test.login('HR01');
select test.eq((select array_agg(r ->> 'code' order by r ->> 'code')
                from jsonb_array_elements(public.list_employees(p_status => 'setup_pending') -> 'data' -> 'rows') r),
               array['ADM100','EMP02','EMP100','HR100'], 'the setup filter finds first-password and interrupted accounts in this organisation');
select test.throws($$select pg_temp.lock_setup('HR01', id) from staged_accounts where code = 'EMP100'$$,
                   '42501', 'the browser role cannot call the provisioning function directly');

select test.as_service();
select test.throws($$select pg_temp.lock_setup('EMP01', id) from staged_accounts where code = 'EMP100'$$,
                   'ACCESS_DENIED', 'employees cannot complete account setup');
select test.throws($$select pg_temp.lock_setup('HR01', id) from staged_accounts where code = 'HR100'$$,
                   'ACCESS_DENIED', 'HR cannot issue setup credentials to HR');
select test.throws($$select pg_temp.lock_setup('HR01', id) from staged_accounts where code = 'ADM100'$$,
                   'ACCESS_DENIED', 'HR cannot issue setup credentials to Admins');
select test.throws($$select pg_temp.lock_setup('ADMIN01', test.emp('EMP09'))$$,
                   'ACCESS_DENIED', 'the Admin must belong to the same organisation');
select test.throws($$select pg_temp.lock_setup('HR01', test.emp('EMP03'))$$,
                   'CONFLICT', 'an inactive account cannot be reactivated through setup');
select test.throws($$select pg_temp.lock_setup('ADMIN01', id) from staged_accounts where code = 'ADM100'$$,
                   'REAUTH_REQUIRED', 'finishing another Admin setup requires reauthentication');
select test.eq(pg_temp.lock_setup('ADMIN01', (select id from staged_accounts where code = 'HR100')) ->> 'employee_code',
               'HR100', 'an Admin can finish setup for HR');

create temporary table setup_context as
select pg_temp.lock_setup('HR01', id) as context from staged_accounts where code = 'EMP100';
select test.ok((select context ->> 'operation_id' is not null from setup_context), 'HR resumes the employee’s original provisioning operation');
select public.internal_provision_link(p.auth_user_id, p.session_id, p.alias, (c.context ->> 'operation_id')::uuid,
    iam.create_user(c.context ->> 'auth_alias', '$argon2id$test-only'))
from test.people p cross join setup_context c where p.code = 'HR01';
select test.eq(pg_temp.lock_setup('HR01', (select id from staged_accounts where code = 'EMP100')) ->> 'already',
               'true', 'retrying completion recognises the active account');

select test.as_admin_db();
select test.ok((select status = 'active' and provisioning_state = 'complete' and must_change_password
                from hrms.employees where id = (select id from staged_accounts where code = 'EMP100')),
               'completed setup activates sign-in with a required password change');
rollback;
