-- Empty organisations must have real, selectable leave types after bootstrap.
begin;

select hrms.bootstrap_org_admin('LEAVE_SETUP', 'Leave setup', 'Asia/Kolkata', 'OWNER01', 'Owner', 'staff.hrms.invalid');
select test.eq((select array_agg(code order by code) from hrms.leave_types
                where org_id = test.org('LEAVE_SETUP') and active),
               array['ML', 'PL', 'UL'], 'bootstrap provides active Medical, Paid and Unpaid leave');
select test.ok((select paid and requires_attachment and attachment_class = 'medical' from hrms.leave_types
                where org_id = test.org('LEAVE_SETUP') and code = 'ML'), 'medical leave requires a medical document');
select test.ok((select not paid from hrms.leave_types
                where org_id = test.org('LEAVE_SETUP') and code = 'UL'), 'unpaid leave has no paid entitlement');
select test.eq((select count(*)::integer from hrms.leave_policies where org_id = test.org('LEAVE_SETUP')),
               0, 'default types do not invent paid entitlements');

-- Also repair an empty setup when bootstrap finds its Admin and returns early.
delete from hrms.leave_types where org_id = test.org('LEAVE_SETUP');
select hrms.bootstrap_org_admin('LEAVE_SETUP', 'Leave setup', 'Asia/Kolkata', 'OWNER01', 'Owner', 'staff.hrms.invalid');
select test.eq((select count(*)::integer from hrms.leave_types where org_id = test.org('LEAVE_SETUP') and active),
               3, 'existing Admin bootstrap also repairs an empty setup');

-- The employee-facing API must return the seeded types, not an empty array.
select test.person('LEAVE_SETUP', 'SETUP01', 'Employee');
select test.login('SETUP01');
select test.eq(jsonb_array_length(public.list_leave_types(false) -> 'data'), 3,
               'employees can select the bootstrap leave types');
select test.throws($$select hrms.seed_initial_leave_types(test.org('LEAVE_SETUP'))$$,
                   '42501', 'employees cannot invoke the setup helper');
select test.as_admin_db();

update hrms.leave_types set name = 'Custom paid leave', active = false, version = version + 1
where org_id = test.org('LEAVE_SETUP') and code = 'PL';
select hrms.bootstrap_org_admin('LEAVE_SETUP', 'Leave setup', 'Asia/Kolkata', 'OWNER01', 'Owner', 'staff.hrms.invalid');
select test.eq((select count(*)::integer from hrms.leave_types where org_id = test.org('LEAVE_SETUP')),
               3, 'repeated bootstrap does not duplicate types');
select test.ok((select name = 'Custom paid leave' and not active and version = 2 from hrms.leave_types
                where org_id = test.org('LEAVE_SETUP') and code = 'PL'), 'bootstrap preserves names and inactive types');

-- Existing custom configurations are not supplemented or rewritten.
select test.org('CUSTOM_LEAVE');
insert into hrms.leave_types (org_id, code, name, paid) values (test.org('CUSTOM_LEAVE'), 'CUSTOM', 'Custom leave', false);
select hrms.seed_initial_leave_types(test.org('CUSTOM_LEAVE'));
select hrms.bootstrap_org_admin('CUSTOM_LEAVE', 'Custom leave', 'Asia/Kolkata', 'CUSTOM01', 'Owner', 'staff.hrms.invalid');
select test.eq((select array_agg(code) from hrms.leave_types where org_id = test.org('CUSTOM_LEAVE')),
               array['CUSTOM'], 'existing custom types are preserved');

-- The migration uses the same helper to repair already-existing empty setups.
select test.org('OLD_EMPTY_LEAVE');
select hrms.seed_initial_leave_types(test.org('OLD_EMPTY_LEAVE'));
select test.eq((select array_agg(code order by code) from hrms.leave_types where org_id = test.org('OLD_EMPTY_LEAVE')),
               array['ML', 'PL', 'UL'], 'backfill helper repairs existing empty organisations');

rollback;
