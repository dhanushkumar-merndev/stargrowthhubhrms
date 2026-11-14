-- [web-hrms] Ported from ~/Documents/Projects/november/fingertipssl/supabase/migrations/20261112130000_device_auto_register.sql
-- [web-hrms]   unchanged

-- =============================================================================
-- Device feature (moves to the HRMS): people are registered on the machines
-- automatically.
--
--   * Adding an active employee (or re-activating one) gives them a machine
--     PIN and queues them to every machine that accepts commands. Renames and
--     deactivations already followed them (employees_device_sync).
--   * A machine's "done" answer to a user add/delete updates the machine
--     roster (device_users) — machines do not report users the server added,
--     so without this a pushed person looked "not on a machine" forever.
--   * HR/Admin can re-send everyone at once (sync_all_employee_devices).
-- =============================================================================

-- Give an employee a machine PIN (any-device link) if they have none.
-- Returns the PIN. Never reuses a number a machine or an old link has used.
create or replace function hrms.device_ensure_pin(p_org uuid, p_employee uuid, p_actor uuid)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_pin text;
  v_link uuid;
begin
  perform hrms.device_lock_org(p_org);
  select pin into v_pin from hrms.device_user_links
  where org_id = p_org and employee_id = p_employee and unlinked_at is null and serial is null
  order by linked_at limit 1;
  if v_pin is not null then
    return v_pin;
  end if;

  select (coalesce(max(pin::bigint), 0) + 1)::text into v_pin
  from (
    select pin from hrms.device_user_links where org_id = p_org
    union all
    select pin from hrms.device_users where org_id = p_org
    union all
    select pin from hrms.device_punch_events where org_id = p_org
  ) s
  where pin ~ '^[0-9]{1,9}$';
  if v_pin::bigint > 999999999 then
    perform hrms.raise_error('VALIDATION_FAILED', 'No free machine PIN left.');
  end if;
  insert into hrms.device_user_links (org_id, serial, pin, employee_id, linked_by)
  values (p_org, null, v_pin, p_employee, p_actor)
  returning id into v_link;
  perform hrms.audit(p_org, p_actor, 'device_user.link', 'device_user_link', v_link,
    jsonb_build_object('pin', v_pin, 'serial', null, 'employee_id', p_employee, 'assigned', true), 'business', p_employee);
  return v_pin;
end;
$$;

-- The signed-in actor's employee id, or null (service role, setup scripts).
create or replace function hrms.device_actor_or_null() returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return (hrms.current_actor()).employee_id;
exception when others then
  return null;
end;
$$;

-- Employees follow onto the machines: new/re-activated → PIN + add;
-- renamed → update; deactivated → delete (with their fingerprints there).
create or replace function hrms.device_employee_changed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' then
      v_actor := hrms.device_actor_or_null();
      perform hrms.device_ensure_pin(new.org_id, new.id, v_actor);
      perform hrms.device_sync_employee(new.org_id, new.id, 'assign_pin', v_actor);
    end if;
  elsif new.full_name is distinct from old.full_name or new.status is distinct from old.status then
    v_actor := hrms.device_actor_or_null();
    if new.status = 'active' then
      perform hrms.device_ensure_pin(new.org_id, new.id, v_actor);
    end if;
    perform hrms.device_sync_employee(new.org_id, new.id, 'employee_changed', v_actor);
  end if;
  return null;
end;
$$;

drop trigger if exists employees_device_sync on hrms.employees;
create trigger employees_device_sync after update of full_name, status on hrms.employees
  for each row execute function hrms.device_employee_changed();
create trigger employees_device_register after insert on hrms.employees
  for each row execute function hrms.device_employee_changed();

-- assign_device_pin keeps its contract; the work moved to device_ensure_pin.
create or replace function public.assign_device_pin(p_employee_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_emp hrms.employees;
  v_had boolean;
  v_pin text;
  v_queued integer;
begin
  select * into v_emp from hrms.employees where id = p_employee_id and org_id = v_actor.org_id;
  if v_emp.id is null or v_emp.status <> 'active' then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose an active employee.', jsonb_build_object('employee_id', 'invalid'));
  end if;
  v_had := exists (select 1 from hrms.device_user_links
                   where org_id = v_actor.org_id and employee_id = v_emp.id and unlinked_at is null and serial is null);
  v_pin := hrms.device_ensure_pin(v_actor.org_id, v_emp.id, v_actor.employee_id);
  v_queued := hrms.device_sync_employee(v_actor.org_id, v_emp.id, 'assign_pin', v_actor.employee_id);
  return hrms.ok(jsonb_build_object('pin', v_pin, 'new', not v_had, 'queued', v_queued));
end;
$$;

-- devicecmd results: record the answer, and when a user add/delete succeeded,
-- update the machine roster to match (the machine will not report it).
create or replace function public.internal_device_command_results(
  p_secret text, p_serial text, p_token text, p_ip_hash text, p_results jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gate jsonb;
  r jsonb;
  v_id bigint;
  v_ret integer;
  v_n integer := 0;
  c hrms.device_commands;
begin
  v_gate := public.internal_device_gate(p_secret, p_serial, p_token, p_ip_hash, 'devicecmd', '{}'::jsonb);
  if not coalesce((v_gate ->> 'ok')::boolean, false) then
    return v_gate;
  end if;
  if jsonb_typeof(p_results) is distinct from 'array' then
    return jsonb_build_object('ok', true, 'updated', 0);
  end if;
  for r in select value from jsonb_array_elements(p_results) limit 100 loop
    begin
      v_id := (r ->> 'id')::bigint;
      v_ret := (r ->> 'return')::integer;
    exception when others then
      continue;
    end;
    update hrms.device_commands
       set status = case when v_ret = 0 then 'done' else 'failed' end,
           return_code = v_ret, completed_at = now()
     where id = v_id and serial = v_gate ->> 'serial' and status in ('sent', 'queued')
    returning * into c;
    if found then
      v_n := v_n + 1;
      if c.status = 'done' then
        perform hrms.device_roster_apply(c);
      end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'updated', v_n);
end;
$$;

create or replace function hrms.device_roster_apply(c hrms.device_commands) returns void
language plpgsql
set search_path = ''
as $$
begin
  if c.kind = 'user_upsert' then
    insert into hrms.device_users (org_id, serial, pin, name, is_device_admin)
    values (c.org_id, c.serial, c.pin, c.payload ->> 'name', c.payload ->> 'privilege' = '14')
    on conflict (serial, pin) do update
      set name = excluded.name, is_device_admin = excluded.is_device_admin, last_reported_at = now();
  elsif c.kind = 'user_delete' then
    delete from hrms.device_users where serial = c.serial and pin = c.pin;
  end if;
end;
$$;

-- HR/Admin: make sure every active person has a PIN and re-send everyone
-- (active → add/update, inactive → remove) to the machines that accept
-- commands. Safe to repeat: open commands for the same PIN are superseded.
create or replace function public.sync_all_employee_devices() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  e record;
  v_people integer := 0;
  v_pins integer := 0;
  v_queued integer := 0;
begin
  for e in select id, status from hrms.employees where org_id = v_actor.org_id order by created_at, id loop
    if e.status = 'active' and not exists (
         select 1 from hrms.device_user_links
         where org_id = v_actor.org_id and employee_id = e.id and unlinked_at is null and serial is null) then
      perform hrms.device_ensure_pin(v_actor.org_id, e.id, v_actor.employee_id);
      v_pins := v_pins + 1;
    end if;
    v_queued := v_queued + hrms.device_sync_employee(v_actor.org_id, e.id, 'sync', v_actor.employee_id);
    v_people := v_people + 1;
  end loop;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_command.sync_all', 'organization', v_actor.org_id,
    jsonb_build_object('people', v_people, 'new_pins', v_pins, 'queued', v_queued), 'business', null);
  return hrms.ok(jsonb_build_object('people', v_people, 'new_pins', v_pins, 'queued', v_queued));
end;
$$;

-- Backfill: users the machines already accepted from us appear on the roster.
do $$
declare c hrms.device_commands;
begin
  for c in
    select distinct on (serial, pin) * from hrms.device_commands
    where status = 'done' and kind in ('user_upsert', 'user_delete')
    order by serial, pin, completed_at desc, id desc
  loop
    if not exists (
         select 1 from hrms.device_users u
         where u.serial = c.serial and u.pin = c.pin and u.last_reported_at > c.completed_at) then
      perform hrms.device_roster_apply(c);
    end if;
  end loop;
end $$;

revoke all on function hrms.device_ensure_pin(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function hrms.device_roster_apply(hrms.device_commands) from public, anon, authenticated;
revoke all on function hrms.device_actor_or_null() from public, anon, authenticated;
select hrms.apply_api_grants();
