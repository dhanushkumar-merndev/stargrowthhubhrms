-- [web-hrms] Ported from ~/Documents/Projects/november/fingertipssl/supabase/migrations/20261112110000_device_commands.sql
-- [web-hrms]   unchanged

-- =============================================================================
-- Machine command channel (narrow allowlist). MOVES INTO THE HRMS.
--
-- The web app becomes the staff list: an employee gets a machine PIN from the
-- app and is pushed to the machines; HR can start fingerprint enrolment.
--
-- Safety:
--   * OFF per machine until an Admin turns it on (attendance_devices.commands_enabled).
--   * Only three command kinds exist, and the command text is built here from
--     validated fields, never from client text:
--       user_upsert         DATA UPDATE USERINFO PIN=<digits> Name=<clean> Pri=<0|14>
--       user_delete         DATA DELETE USERINFO PIN=<digits>
--       enroll_fingerprint  ENROLL_FP PIN=<digits> FID=<0-9> RETRY=3 OVERWRITE=<0|1>
--     Nothing can reboot, clear, update firmware, open doors or read templates.
--   * HR/Admin only, audited; system-queued commands (employee rename /
--     deactivation) carry no actor and are traceable to the employee audit row.
--   * Unsent commands expire after 24 h; a sent command is retried at most 3
--     times (enrolment never), then marked failed.
--   * Fingerprints/faces created by enrolment stay on the machine; the route
--     keeps discarding every biometric table.
-- =============================================================================

alter table hrms.attendance_devices add column commands_enabled boolean not null default false;

create table hrms.device_commands (
  id bigint generated always as identity primary key,
  org_id uuid not null references hrms.organizations(id) on delete restrict,
  serial text not null references hrms.attendance_devices(serial) on delete restrict,
  kind text not null check (kind in ('user_upsert', 'user_delete', 'enroll_fingerprint')),
  pin text not null check (pin ~ '^[0-9]{1,9}$'),
  employee_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'done', 'failed', 'expired', 'cancelled')),
  attempts smallint not null default 0,
  return_code integer,
  reason text not null check (reason in ('assign_pin', 'sync', 'employee_changed', 'enroll')),
  created_by uuid,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours',
  foreign key (org_id, employee_id) references hrms.employees(org_id, id) on delete restrict,
  -- Defence in depth: the only payload shapes that can ever be rendered.
  check (case kind
    when 'user_upsert' then
      jsonb_typeof(payload -> 'name') = 'string'
      and char_length(payload ->> 'name') between 1 and 24
      and (payload ->> 'name') !~ '[[:cntrl:]]'
      and (payload ->> 'privilege') in ('0', '14')
    when 'user_delete' then payload = '{}'::jsonb
    when 'enroll_fingerprint' then
      (payload ->> 'finger') ~ '^[0-9]$' and (payload ->> 'overwrite') in ('0', '1')
    else false end)
);
create index device_commands_open_idx on hrms.device_commands (serial, id) where status in ('queued', 'sent');
create index device_commands_org_idx on hrms.device_commands (org_id, created_at desc);
create index device_commands_emp_idx on hrms.device_commands (employee_id, created_at desc);

-- -----------------------------------------------------------------------------
-- Internals
-- -----------------------------------------------------------------------------

-- What the machine receives for one command (C:<id>:<command>).
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
  end;
$$;

-- Machine display name: printable, single line, 24 characters.
create or replace function hrms.device_display_name(p_name text) returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(left(btrim(regexp_replace(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), 24), '');
$$;

-- Queues one command on a machine that has commands enabled. Returns the id,
-- or null when the machine is inactive / not enabled. An upsert and a delete
-- for the same PIN supersede each other (latest wins).
create or replace function hrms.device_queue(
  p_org uuid, p_serial text, p_kind text, p_pin text, p_employee uuid, p_payload jsonb, p_reason text, p_actor uuid
) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if not exists (select 1 from hrms.attendance_devices
                 where serial = p_serial and org_id = p_org and active and commands_enabled) then
    return null;
  end if;
  if (select count(*) from hrms.device_commands where serial = p_serial and status in ('queued', 'sent')) >= 500 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Too many commands are waiting for this machine; check that it is online.');
  end if;
  if p_kind in ('user_upsert', 'user_delete') then
    update hrms.device_commands set status = 'cancelled', completed_at = now()
    where serial = p_serial and pin = p_pin and status = 'queued' and kind in ('user_upsert', 'user_delete');
  end if;
  insert into hrms.device_commands (org_id, serial, kind, pin, employee_id, payload, reason, created_by)
  values (p_org, p_serial, p_kind, p_pin, p_employee, coalesce(p_payload, '{}'::jsonb), p_reason, p_actor)
  returning id into v_id;
  return v_id;
end;
$$;

-- Pushes an employee to every machine their PIN(s) apply to: an any-device
-- link targets all enabled machines, a device-specific link only that one.
-- Active → upsert (keeping a machine-admin's privilege); otherwise → delete.
-- Returns the number of commands queued.
create or replace function hrms.device_sync_employee(p_org uuid, p_employee uuid, p_reason text, p_actor uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_emp hrms.employees;
  v_name text;
  r record;
  v_n integer := 0;
  v_id bigint;
begin
  select * into v_emp from hrms.employees where id = p_employee and org_id = p_org;
  if v_emp.id is null then
    return 0;
  end if;
  v_name := coalesce(hrms.device_display_name(v_emp.full_name), v_emp.employee_code);
  for r in
    select distinct d.serial, l.pin
    from hrms.device_user_links l
    join hrms.attendance_devices d
      on d.org_id = l.org_id and (l.serial is null or d.serial = l.serial)
    where l.org_id = p_org and l.employee_id = p_employee and l.unlinked_at is null
      and l.pin ~ '^[0-9]{1,9}$' and d.active and d.commands_enabled
  loop
    if v_emp.status = 'active' then
      v_id := hrms.device_queue(p_org, r.serial, 'user_upsert', r.pin, p_employee,
        jsonb_build_object('name', v_name, 'privilege',
          case when exists (select 1 from hrms.device_users u
                            where u.serial = r.serial and u.pin = r.pin and u.is_device_admin)
               then '14' else '0' end),
        p_reason, p_actor);
    else
      v_id := hrms.device_queue(p_org, r.serial, 'user_delete', r.pin, p_employee, '{}'::jsonb, p_reason, p_actor);
    end if;
    if v_id is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- Renaming or (de)activating an employee follows them onto the machines.
create or replace function hrms.device_employee_changed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.full_name is distinct from old.full_name or new.status is distinct from old.status then
    perform hrms.device_sync_employee(new.org_id, new.id, 'employee_changed', null);
  end if;
  return null;
end;
$$;
create trigger employees_device_sync after update of full_name, status on hrms.employees
  for each row execute function hrms.device_employee_changed();

-- Command status changes are broadcast so open dashboards update.
create or replace function hrms.device_command_broadcast() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send(
      jsonb_build_object('id', new.id, 'status', new.status, 'op', tg_op),
      'command',
      'hrms:device-punches:' || new.org_id::text,
      true
    );
  end if;
  return null;
exception when others then
  return null;
end;
$$;
create trigger device_commands_broadcast after insert or update of status on hrms.device_commands
  for each row execute function hrms.device_command_broadcast();

-- -----------------------------------------------------------------------------
-- Device side (service role only; called by the /iclock route)
-- -----------------------------------------------------------------------------

-- getrequest: heartbeat + command poll. Authenticates like the gate, expires
-- and fails stale commands, then hands out up to 10 commands in id order.
create or replace function public.internal_device_poll(
  p_secret text, p_serial text, p_token text, p_ip_hash text, p_meta jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gate jsonb;
  v_dev hrms.attendance_devices;
  v_lines text[];
begin
  v_gate := public.internal_device_gate(p_secret, p_serial, p_token, p_ip_hash, 'getrequest', p_meta);
  if not coalesce((v_gate ->> 'ok')::boolean, false) then
    return v_gate;
  end if;
  select * into v_dev from hrms.attendance_devices where serial = v_gate ->> 'serial';
  if not v_dev.commands_enabled then
    return jsonb_build_object('ok', true, 'commands', '[]'::jsonb);
  end if;

  update hrms.device_commands set status = 'expired', completed_at = now()
  where serial = v_dev.serial and status = 'queued' and expires_at < now();
  update hrms.device_commands set status = 'failed', completed_at = now()
  where serial = v_dev.serial and status = 'sent'
    and ((kind = 'enroll_fingerprint' and sent_at < now() - interval '10 minutes')
      or (kind <> 'enroll_fingerprint' and attempts >= 3 and sent_at < now() - interval '2 minutes'));

  with picked as (
    select id from hrms.device_commands
    where serial = v_dev.serial
      and (status = 'queued'
           or (status = 'sent' and kind <> 'enroll_fingerprint' and attempts < 3
               and sent_at < now() - interval '2 minutes'))
    order by id
    limit 10
    for update skip locked
  ), sent as (
    update hrms.device_commands c
       set status = 'sent', attempts = c.attempts + 1, sent_at = now()
      from picked
     where c.id = picked.id
    returning c.*
  )
  select array_agg(hrms.device_command_line(s::hrms.device_commands) order by s.id) into v_lines from sent s;

  return jsonb_build_object('ok', true, 'commands', to_jsonb(coalesce(v_lines, array[]::text[])));
end;
$$;

-- devicecmd: the machine reports results. p_results: [{id, return}] — only
-- this machine's sent commands can be completed.
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
     where id = v_id and serial = v_gate ->> 'serial' and status in ('sent', 'queued');
    if found then
      v_n := v_n + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'updated', v_n);
end;
$$;

-- -----------------------------------------------------------------------------
-- Dashboard RPCs
-- -----------------------------------------------------------------------------

-- Admin: turn the command channel on/off for one machine. Turning it off
-- cancels everything still waiting.
create or replace function public.set_device_commands(p_device_id uuid, p_enabled boolean) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_dev hrms.attendance_devices;
  v_cancelled integer := 0;
begin
  if not ('admin' = any(v_actor.roles)) then
    perform hrms.raise_error('ACCESS_DENIED', 'Only an Admin can allow commands to a machine.');
  end if;
  select * into v_dev from hrms.attendance_devices where id = p_device_id and org_id = v_actor.org_id for update;
  if v_dev.id is null then
    perform hrms.raise_error('NOT_FOUND');
  end if;
  if v_dev.commands_enabled is distinct from coalesce(p_enabled, false) then
    update hrms.attendance_devices set commands_enabled = coalesce(p_enabled, false) where id = v_dev.id;
    if not coalesce(p_enabled, false) then
      update hrms.device_commands set status = 'cancelled', completed_at = now()
      where serial = v_dev.serial and status in ('queued', 'sent');
      get diagnostics v_cancelled = row_count;
    end if;
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device.commands', 'attendance_device', v_dev.id,
      jsonb_build_object('serial', v_dev.serial, 'enabled', coalesce(p_enabled, false), 'cancelled', v_cancelled),
      'security');
  end if;
  return hrms.ok(jsonb_build_object('commands_enabled', coalesce(p_enabled, false), 'cancelled', v_cancelled));
end;
$$;

-- HR/Admin: give an employee the next free numeric machine PIN (valid on every
-- machine) and push them to the machines. Returns their PIN if they have one.
create or replace function public.assign_device_pin(p_employee_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_emp hrms.employees;
  v_pin text;
  v_link uuid;
  v_new boolean := false;
  v_queued integer;
begin
  select * into v_emp from hrms.employees where id = p_employee_id and org_id = v_actor.org_id;
  if v_emp.id is null or v_emp.status <> 'active' then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose an active employee.', jsonb_build_object('employee_id', 'invalid'));
  end if;
  perform hrms.device_lock_org(v_actor.org_id);

  select pin into v_pin from hrms.device_user_links
  where org_id = v_actor.org_id and employee_id = v_emp.id and unlinked_at is null and serial is null
  order by linked_at limit 1;

  if v_pin is null then
    -- Never reuse a number that a machine or an old link has used.
    select (coalesce(max(pin::bigint), 0) + 1)::text into v_pin
    from (
      select pin from hrms.device_user_links where org_id = v_actor.org_id
      union all
      select pin from hrms.device_users where org_id = v_actor.org_id
      union all
      select pin from hrms.device_punch_events where org_id = v_actor.org_id
    ) s
    where pin ~ '^[0-9]{1,9}$';
    if v_pin::bigint > 999999999 then
      perform hrms.raise_error('VALIDATION_FAILED', 'No free machine PIN left.');
    end if;
    insert into hrms.device_user_links (org_id, serial, pin, employee_id, linked_by)
    values (v_actor.org_id, null, v_pin, v_emp.id, v_actor.employee_id)
    returning id into v_link;
    v_new := true;
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_user.link', 'device_user_link', v_link,
      jsonb_build_object('pin', v_pin, 'serial', null, 'employee_id', v_emp.id, 'assigned', true), 'business', v_emp.id);
  end if;

  v_queued := hrms.device_sync_employee(v_actor.org_id, v_emp.id, 'assign_pin', v_actor.employee_id);
  return hrms.ok(jsonb_build_object('pin', v_pin, 'new', v_new, 'queued', v_queued));
end;
$$;

-- HR/Admin: (re)send an employee's name/status to the machines.
create or replace function public.sync_employee_devices(p_employee_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_queued integer;
begin
  if not exists (select 1 from hrms.employees where id = p_employee_id and org_id = v_actor.org_id) then
    perform hrms.raise_error('NOT_FOUND');
  end if;
  if not exists (select 1 from hrms.device_user_links
                 where employee_id = p_employee_id and unlinked_at is null and pin ~ '^[0-9]{1,9}$') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Give this person a machine PIN first.');
  end if;
  v_queued := hrms.device_sync_employee(v_actor.org_id, p_employee_id, 'sync', v_actor.employee_id);
  if v_queued > 0 then
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_command.sync', 'employee', p_employee_id,
      jsonb_build_object('queued', v_queued), 'business', p_employee_id);
  end if;
  return hrms.ok(jsonb_build_object('queued', v_queued));
end;
$$;

-- HR/Admin: open the fingerprint enrolment screen for an employee on one
-- machine. Pushes the user first if the machine has not reported them yet.
-- p_finger: 0–9 (machine finger index; 6 = right index on most firmware).
create or replace function public.enroll_device_fingerprint(
  p_employee_id uuid, p_serial text, p_finger integer default 6, p_overwrite boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_emp hrms.employees;
  v_dev hrms.attendance_devices;
  v_pin text;
  v_user_id bigint;
  v_enroll_id bigint;
begin
  select * into v_emp from hrms.employees where id = p_employee_id and org_id = v_actor.org_id;
  if v_emp.id is null or v_emp.status <> 'active' then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose an active employee.', jsonb_build_object('employee_id', 'invalid'));
  end if;
  select * into v_dev from hrms.attendance_devices where serial = btrim(coalesce(p_serial, '')) and org_id = v_actor.org_id;
  if v_dev.id is null or not v_dev.active then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose an active machine.', jsonb_build_object('serial', 'invalid'));
  end if;
  if not v_dev.commands_enabled then
    perform hrms.raise_error('VALIDATION_FAILED', 'Commands are off for this machine. An Admin can turn them on under Devices.',
                             jsonb_build_object('serial', 'commands_disabled'));
  end if;
  if p_finger is null or p_finger not between 0 and 9 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose a finger.', jsonb_build_object('finger', 'invalid'));
  end if;

  select pin into v_pin from hrms.device_user_links
  where org_id = v_actor.org_id and employee_id = v_emp.id and unlinked_at is null
    and (serial = v_dev.serial or serial is null) and pin ~ '^[0-9]{1,9}$'
  order by (serial is null), linked_at desc
  limit 1;
  if v_pin is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'Give this person a machine PIN first.', jsonb_build_object('pin', 'missing'));
  end if;

  perform hrms.device_lock_org(v_actor.org_id);
  if not exists (select 1 from hrms.device_users where serial = v_dev.serial and pin = v_pin) then
    v_user_id := hrms.device_queue(v_actor.org_id, v_dev.serial, 'user_upsert', v_pin, v_emp.id,
      jsonb_build_object('name', coalesce(hrms.device_display_name(v_emp.full_name), v_emp.employee_code), 'privilege', '0'),
      'enroll', v_actor.employee_id);
  end if;
  v_enroll_id := hrms.device_queue(v_actor.org_id, v_dev.serial, 'enroll_fingerprint', v_pin, v_emp.id,
    jsonb_build_object('finger', p_finger::text, 'overwrite', case when p_overwrite then '1' else '0' end),
    'enroll', v_actor.employee_id);

  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_command.enroll', 'employee', v_emp.id,
    jsonb_build_object('serial', v_dev.serial, 'pin', v_pin, 'finger', p_finger, 'overwrite', p_overwrite,
                       'command_id', v_enroll_id), 'business', v_emp.id);
  return hrms.ok(jsonb_build_object('command_id', v_enroll_id, 'user_command_id', v_user_id, 'pin', v_pin));
end;
$$;

-- HR/Admin: withdraw a command the machine has not picked up yet.
create or replace function public.cancel_device_command(p_command_id bigint) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
begin
  update hrms.device_commands set status = 'cancelled', completed_at = now()
  where id = p_command_id and org_id = v_actor.org_id and status = 'queued';
  if not found then
    perform hrms.raise_error('VALIDATION_FAILED', 'Only a command that is still waiting can be cancelled.');
  end if;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_command.cancel', 'device_command', null,
    jsonb_build_object('command_id', p_command_id), 'business');
  return hrms.ok(jsonb_build_object('id', p_command_id));
end;
$$;

-- HR/Admin: recent commands, optionally for one employee.
create or replace function public.list_device_commands(p_employee_id uuid default null, p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
begin
  return hrms.ok(coalesce((
    select jsonb_agg(row_json order by id desc)
    from (
      select c.id, jsonb_build_object(
        'id', c.id, 'serial', c.serial, 'device_label', d.label, 'kind', c.kind, 'pin', c.pin,
        'employee', case when e.id is not null then jsonb_build_object('id', e.id, 'name', e.full_name, 'code', e.employee_code) end,
        'name', c.payload ->> 'name', 'finger', (c.payload ->> 'finger')::integer,
        'status', c.status, 'attempts', c.attempts, 'return_code', c.return_code, 'reason', c.reason,
        'created_by', (select full_name from hrms.employees a where a.id = c.created_by),
        'created_at', c.created_at, 'sent_at', c.sent_at, 'completed_at', c.completed_at
      ) as row_json
      from hrms.device_commands c
      left join hrms.attendance_devices d on d.serial = c.serial
      left join hrms.employees e on e.id = c.employee_id
      where c.org_id = v_actor.org_id and (p_employee_id is null or c.employee_id = p_employee_id)
      order by c.id desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) s
  ), '[]'::jsonb));
end;
$$;

-- HR/Admin: per employee, which machines know their PIN (as last reported by
-- the machines) and how many commands are still waiting.
create or replace function public.list_employee_device_status() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
begin
  return hrms.ok(coalesce((
    select jsonb_agg(jsonb_build_object(
      'employee_id', e.id,
      'machines', (select coalesce(jsonb_agg(jsonb_build_object('serial', u.serial, 'label', d.label, 'pin', u.pin,
                                                                'name', u.name) order by d.label), '[]'::jsonb)
                   from hrms.device_users u
                   join hrms.attendance_devices d on d.serial = u.serial
                   join hrms.device_user_links l on l.org_id = u.org_id and l.pin = u.pin and l.unlinked_at is null
                                               and (l.serial is null or l.serial = u.serial)
                   where u.org_id = e.org_id and l.employee_id = e.id),
      'pending_commands', (select count(*) from hrms.device_commands c
                           where c.employee_id = e.id and c.status in ('queued', 'sent')),
      'last_command', (select jsonb_build_object('kind', c.kind, 'status', c.status, 'return_code', c.return_code,
                                                 'device_label', d.label, 'at', coalesce(c.completed_at, c.created_at))
                       from hrms.device_commands c join hrms.attendance_devices d on d.serial = c.serial
                       where c.employee_id = e.id order by c.id desc limit 1)
    ))
    from hrms.employees e where e.org_id = v_actor.org_id
  ), '[]'::jsonb));
end;
$$;

-- Devices list gains the command switch and the waiting-command count.
create or replace function public.list_attendance_devices() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
begin
  return hrms.ok(coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'serial', d.serial, 'label', d.label, 'office', o.name, 'office_id', d.office_id, 'mode', d.mode,
      'active', d.active, 'has_token', d.token_sha256 is not null,
      'commands_enabled', d.commands_enabled,
      'open_commands', (select count(*) from hrms.device_commands c where c.serial = d.serial and c.status in ('queued', 'sent')),
      'last_seen_at', d.last_seen_at, 'last_punch_received_at', d.last_punch_received_at,
      'firmware', d.firmware, 'push_version', d.push_version,
      'clock_drift_seconds', d.clock_drift_seconds,
      'punches_today', (select count(*) from hrms.device_punch_events p
                        where p.serial = d.serial
                          and p.device_local_time >= (now() at time zone org.timezone)::date::timestamp),
      'rejections_24h', (select count(*) from hrms.device_ingest_rejections r
                         where r.serial = d.serial and r.created_at > now() - interval '24 hours'),
      'machine_users', (select count(*) from hrms.device_users u where u.serial = d.serial)
    ) order by d.label)
    from hrms.attendance_devices d
    join hrms.organizations org on org.id = d.org_id
    left join hrms.offices o on o.id = d.office_id
    where d.org_id = v_actor.org_id
  ), '[]'::jsonb));
end;
$$;

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'hrms' loop
    execute format('alter table hrms.%I enable row level security', r.tablename);
  end loop;
end $$;

select hrms.apply_api_grants();
