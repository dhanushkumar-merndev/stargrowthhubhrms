-- [web-hrms] Bridge between HRMS employee lifecycle and the eSSL device feature.
--
-- In fingertipssl the stub `remove_employee` called hrms.device_forget_employee
-- (queue a machine delete + unlink every PIN). In HRMS the person is removed
-- from the organisation by public.set_employee_status(..., 'inactive', ...),
-- which only updates the row. This trigger version keeps one behaviour for both:
--   * insert as active            -> assign the next PIN and push the name
--   * rename while active         -> push the new name
--   * active -> inactive          -> delete from machines + unlink PINs (audited)
--   * inactive/pending -> active  -> assign a PIN (a fresh one if the old was freed)

create or replace function hrms.device_employee_changed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' and coalesce(current_setting('hrms.device_skip_register', true), '') <> 'on' then
      v_actor := hrms.device_actor_or_null();
      perform hrms.device_ensure_pin(new.org_id, new.id, v_actor);
      perform hrms.device_sync_employee(new.org_id, new.id, 'assign_pin', v_actor);
    end if;
    return null;
  end if;

  if new.full_name is not distinct from old.full_name and new.status is not distinct from old.status then
    return null;
  end if;

  v_actor := hrms.device_actor_or_null();
  if old.status = 'active' and new.status <> 'active' then
    perform hrms.device_forget_employee(new.org_id, new.id, v_actor);
  elsif new.status = 'active' then
    perform hrms.device_ensure_pin(new.org_id, new.id, v_actor);
    perform hrms.device_sync_employee(new.org_id, new.id, 'employee_changed', v_actor);
  end if;
  return null;
end;
$$;

-- "Add as employee" from Unmatched (HRMS edition). The HR form starts an HRMS
-- hire (pending); this attaches the machine's PIN to that pending hire BEFORE
-- the account is finished, so activation finds a PIN and does not invent a
-- second one. Unlike link_device_user (which deliberately MOVES a PIN between
-- people), this refuses a PIN that is already in use.
create or replace function public.claim_device_pin_for_hire(p_employee_id uuid, p_serial text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_pin text := btrim(coalesce(p_pin, ''));
  v_serial text := nullif(btrim(coalesce(p_serial, '')), '');
  v_emp hrms.employees;
  v_link_id uuid;
  v_attached integer;
begin
  if v_pin !~ '^[0-9]{1,9}$' then
    perform hrms.raise_error('VALIDATION_FAILED', 'Machine user numbers are 1–9 digits.', jsonb_build_object('pin', 'invalid'));
  end if;
  if v_serial is null or not exists (
    select 1 from hrms.attendance_devices where serial = v_serial and org_id = v_actor.org_id) then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown device.', jsonb_build_object('serial', 'invalid'));
  end if;
  select * into v_emp from hrms.employees where id = p_employee_id and org_id = v_actor.org_id for update;
  if v_emp.id is null or v_emp.status <> 'pending' or v_emp.provisioning_state = 'complete' then
    perform hrms.raise_error('VALIDATION_FAILED', 'Only a new hire that is still being set up can take a machine PIN this way.',
                             jsonb_build_object('employee_id', 'invalid'));
  end if;
  if 'admin' = any(hrms.employee_roles(v_emp.id)) and not hrms.is_admin(v_actor) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;

  perform hrms.device_lock_org(v_actor.org_id);
  -- Retrying the same hire (same operation) with the same PIN is a no-op.
  select id into v_link_id from hrms.device_user_links
   where employee_id = v_emp.id and pin = v_pin and serial = v_serial and unlinked_at is null;
  if found then
    return hrms.ok(jsonb_build_object('link_id', v_link_id, 'attached_punches', 0, 'already', true));
  end if;
  if exists (select 1 from hrms.device_user_links
             where org_id = v_actor.org_id and pin = v_pin and unlinked_at is null
               and (serial is null or serial = v_serial)) then
    perform hrms.raise_error('CONFLICT', 'This machine user is already linked to someone.');
  end if;
  if exists (select 1 from hrms.device_user_links where employee_id = v_emp.id and unlinked_at is null) then
    perform hrms.raise_error('CONFLICT', 'This person already has a machine PIN.');
  end if;

  insert into hrms.device_user_links (org_id, serial, pin, employee_id, linked_by)
  values (v_actor.org_id, v_serial, v_pin, v_emp.id, v_actor.employee_id)
  returning id into v_link_id;

  update hrms.device_punch_events
     set employee_id = v_emp.id, link_id = v_link_id, matched_at = now()
   where org_id = v_actor.org_id and pin = v_pin and employee_id is null and serial = v_serial;
  get diagnostics v_attached = row_count;

  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_user.link', 'device_user_link', v_link_id,
    jsonb_build_object('pin', v_pin, 'serial', v_serial, 'employee_id', v_emp.id, 'reason', 'new_hire'),
    'business', v_emp.id);
  return hrms.ok(jsonb_build_object('link_id', v_link_id, 'attached_punches', v_attached));
end;
$$;
revoke all on function public.claim_device_pin_for_hire(uuid, text, text) from public, anon;
grant execute on function public.claim_device_pin_for_hire(uuid, text, text) to authenticated;

-- A PIN claimed by a new hire who is still being set up is protected too
-- (fingertipssl only protected active employees).
create or replace function public.remove_machine_user(p_serial text, p_pin text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_dev hrms.attendance_devices;
  v_pin text := btrim(coalesce(p_pin, ''));
  v_id bigint;
begin
  select * into v_dev from hrms.attendance_devices where serial = btrim(coalesce(p_serial, '')) and org_id = v_actor.org_id;
  if v_dev.id is null then
    perform hrms.raise_error('NOT_FOUND');
  end if;
  if v_pin !~ '^[0-9]{1,9}$' then
    perform hrms.raise_error('VALIDATION_FAILED', 'Only numeric machine PINs can be removed from here.');
  end if;
  if not (v_dev.active and v_dev.commands_enabled) then
    perform hrms.raise_error('VALIDATION_FAILED', 'Commands are off for this machine. An Admin can turn them on under Devices.');
  end if;
  if exists (select 1 from hrms.device_user_links l join hrms.employees e on e.id = l.employee_id
             where l.org_id = v_actor.org_id and l.pin = v_pin and l.unlinked_at is null
               and (l.serial is null or l.serial = v_dev.serial) and e.status in ('active', 'pending')) then
    perform hrms.raise_error('VALIDATION_FAILED', 'This PIN belongs to an employee (or a new hire being set up). Remove the employee instead.');
  end if;
  v_id := hrms.device_queue(v_actor.org_id, v_dev.serial, 'user_delete', v_pin, null, '{}'::jsonb, 'remove', v_actor.employee_id);
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_command.remove_user', 'attendance_device', v_dev.id,
    jsonb_build_object('serial', v_dev.serial, 'pin', v_pin, 'command_id', v_id), 'business', null);
  return hrms.ok(jsonb_build_object('command_id', v_id));
end;
$$;
