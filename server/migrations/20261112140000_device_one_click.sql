-- [web-hrms] Ported from ~/Documents/Projects/november/fingertipssl/supabase/migrations/20261112140000_device_one_click.sql
-- [web-hrms]   unchanged

-- =============================================================================
-- Device feature (moves to the HRMS): one click everywhere.
--
--   * A person with any PIN (machine-specific or any-machine) is never given a
--     second one.
--   * Linking a PIN to a person (Unmatched) pushes their name to the machines.
--   * Removing a person deletes them from the machines and unlinks their PINs
--     (hrms.device_forget_employee; the HR-facing RPC lives in the stub file).
--   * Unmatched also lists machine users nobody is linked to, and one of them
--     can be removed from the machine.
--   * Face enrolment from the web (ENROLL_BIO), alongside fingerprints. The
--     face/fingerprint template stays on the machine; nothing biometric is
--     received or stored here.
--   * Employee status shows enrolled finger/face and the latest punch photo.
-- =============================================================================

-- ---------------------------------------------------------------- commands
alter table hrms.device_commands drop constraint device_commands_kind_check;
alter table hrms.device_commands add constraint device_commands_kind_check
  check (kind in ('user_upsert', 'user_delete', 'enroll_fingerprint', 'enroll_face'));
alter table hrms.device_commands drop constraint device_commands_reason_check;
alter table hrms.device_commands add constraint device_commands_reason_check
  check (reason in ('assign_pin', 'sync', 'employee_changed', 'enroll', 'remove'));
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
    else false end);

-- ENROLL_BIO TYPE=9 is visible-light face, TYPE=2 near-infrared face (ZKTeco
-- push protocol). Like ENROLL_FP it only opens the enrolment screen.
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
  end;
$$;

-- An identical command already waiting is reused (so a link + a sync in the
-- same click send one command); otherwise a newer upsert/delete for the same
-- PIN replaces the waiting one.
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
  if p_kind in ('user_upsert', 'user_delete') then
    select id into v_id from hrms.device_commands
     where serial = p_serial and pin = p_pin and status = 'queued' and kind = p_kind
       and payload = coalesce(p_payload, '{}'::jsonb)
     order by id desc limit 1;
    if v_id is not null then
      return v_id;
    end if;
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

-- Enrolment commands wait up to 10 minutes for the person and are not retried.
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
    and ((kind in ('enroll_fingerprint', 'enroll_face') and sent_at < now() - interval '10 minutes')
      or (kind in ('user_upsert', 'user_delete') and attempts >= 3 and sent_at < now() - interval '2 minutes'));

  with picked as (
    select id from hrms.device_commands
    where serial = v_dev.serial
      and (status = 'queued'
           or (status = 'sent' and kind in ('user_upsert', 'user_delete') and attempts < 3
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

-- ---------------------------------------------------------------- PINs / links
-- Any active link (machine-specific or not) counts as "has a PIN".
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
  where org_id = p_org and employee_id = p_employee and unlinked_at is null
  order by (serial is null) desc, linked_at limit 1;
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
    union all
    select pin from hrms.device_commands where org_id = p_org
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

-- assign_device_pin: "new" now means "had no PIN at all".
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
                   where org_id = v_actor.org_id and employee_id = v_emp.id and unlinked_at is null);
  v_pin := hrms.device_ensure_pin(v_actor.org_id, v_emp.id, v_actor.employee_id);
  v_queued := hrms.device_sync_employee(v_actor.org_id, v_emp.id, 'assign_pin', v_actor.employee_id);
  return hrms.ok(jsonb_build_object('pin', v_pin, 'new', not v_had, 'queued', v_queued));
end;
$$;

-- sync_all: same rule for "has a PIN".
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
         where org_id = v_actor.org_id and employee_id = e.id and unlinked_at is null) then
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

-- New employee rows are registered unless the caller links an existing
-- machine PIN itself (create_employee_from_pin sets hrms.device_skip_register).
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

-- Linking a PIN (Unmatched) puts the person's name on the machines.
create or replace function hrms.device_link_added() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.unlinked_at is null
     and exists (select 1 from hrms.employees where id = new.employee_id and status = 'active') then
    perform hrms.device_sync_employee(new.org_id, new.employee_id, 'sync', new.linked_by);
  end if;
  return null;
end;
$$;
drop trigger if exists device_user_links_push on hrms.device_user_links;
create trigger device_user_links_push after insert on hrms.device_user_links
  for each row execute function hrms.device_link_added();

-- Delete a person from every machine their PINs apply to (where commands are
-- on) and close their links. Punches already matched stay with them.
create or replace function hrms.device_forget_employee(p_org uuid, p_employee uuid, p_actor uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  perform hrms.device_lock_org(p_org);
  for r in
    select distinct d.serial, l.pin
    from hrms.device_user_links l
    join hrms.attendance_devices d on d.org_id = l.org_id and (l.serial is null or d.serial = l.serial)
    where l.org_id = p_org and l.employee_id = p_employee and l.unlinked_at is null
      and l.pin ~ '^[0-9]{1,9}$' and d.active and d.commands_enabled
  loop
    if hrms.device_queue(p_org, r.serial, 'user_delete', r.pin, p_employee, '{}'::jsonb, 'remove', p_actor) is not null then
      v_n := v_n + 1;
    end if;
  end loop;
  for r in
    update hrms.device_user_links set unlinked_at = now(), unlinked_by = p_actor
     where org_id = p_org and employee_id = p_employee and unlinked_at is null
    returning id, pin, serial
  loop
    perform hrms.audit(p_org, p_actor, 'device_user.unlink', 'device_user_link', r.id,
      jsonb_build_object('pin', r.pin, 'serial', r.serial, 'employee_id', p_employee, 'reason', 'employee_removed'),
      'business', p_employee);
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------- Unmatched
-- Unmatched = PINs with unattributed punches, plus machine users that no
-- active link covers (e.g. added on the machine itself).
create or replace function public.list_unmatched_device_pins() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
begin
  return hrms.ok(coalesce((
    select jsonb_agg(row_json order by last_local desc nulls last, serial, pin)
    from (
      select jsonb_build_object(
        'serial', k.serial, 'device_label', d.label, 'pin', k.pin, 'punches', coalesce(g.n, 0),
        'first_local', to_char(g.first_local, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'last_local', to_char(g.last_local, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'last_punch_id', g.last_id, 'with_photo', coalesce(g.with_photo, 0),
        'machine_name', u.name,
        'on_machine', u.id is not null,
        'linked_to', (select jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name)
                      from hrms.device_user_links l join hrms.employees e on e.id = l.employee_id
                      where l.org_id = v_actor.org_id and l.pin = k.pin and l.unlinked_at is null
                        and (l.serial is null or l.serial = k.serial)
                      order by (l.serial is null) limit 1),
        'can_remove', u.id is not null and d.active and d.commands_enabled and k.pin ~ '^[0-9]{1,9}$'
      ) as row_json, g.last_local, k.serial, k.pin
      from (
        select p.serial, p.pin from hrms.device_punch_events p
        where p.org_id = v_actor.org_id and p.employee_id is null
        union
        select u.serial, u.pin from hrms.device_users u
        where u.org_id = v_actor.org_id
          and not exists (select 1 from hrms.device_user_links l
                          where l.org_id = u.org_id and l.pin = u.pin and l.unlinked_at is null
                            and (l.serial is null or l.serial = u.serial))
      ) k
      left join lateral (
        select count(*) n, min(p.device_local_time) first_local, max(p.device_local_time) last_local,
               (array_agg(p.id order by p.device_local_time desc))[1] last_id,
               count(*) filter (where p.photo_path is not null) with_photo
        from hrms.device_punch_events p
        where p.org_id = v_actor.org_id and p.serial = k.serial and p.pin = k.pin and p.employee_id is null
        having count(*) > 0
      ) g on true
      left join hrms.attendance_devices d on d.serial = k.serial
      left join hrms.device_users u on u.serial = k.serial and u.pin = k.pin
    ) s
  ), '[]'::jsonb));
end;
$$;

-- HR/Admin: delete a machine user that is not linked to an active employee
-- (a leftover or test user). Their fingerprints/face on that machine go too.
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
               and (l.serial is null or l.serial = v_dev.serial) and e.status = 'active') then
    perform hrms.raise_error('VALIDATION_FAILED', 'This PIN belongs to an active employee. Remove the employee instead.');
  end if;
  v_id := hrms.device_queue(v_actor.org_id, v_dev.serial, 'user_delete', v_pin, null, '{}'::jsonb, 'remove', v_actor.employee_id);
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_command.remove_user', 'attendance_device', v_dev.id,
    jsonb_build_object('serial', v_dev.serial, 'pin', v_pin, 'command_id', v_id), 'business', null);
  return hrms.ok(jsonb_build_object('command_id', v_id));
end;
$$;

-- ---------------------------------------------------------------- face
-- HR/Admin: open the face enrolment screen for an employee on one machine.
-- p_face_type '9' = visible-light face (most current eSSL/ZKTeco face
-- terminals), '2' = older near-infrared face.
create or replace function public.enroll_device_face(
  p_employee_id uuid, p_serial text, p_face_type text default '9', p_overwrite boolean default true
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
  if coalesce(p_face_type, '') not in ('9', '2') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown face type.', jsonb_build_object('face_type', 'invalid'));
  end if;

  v_pin := hrms.device_ensure_pin(v_actor.org_id, v_emp.id, v_actor.employee_id);
  select pin into v_pin from hrms.device_user_links
  where org_id = v_actor.org_id and employee_id = v_emp.id and unlinked_at is null
    and (serial = v_dev.serial or serial is null) and pin ~ '^[0-9]{1,9}$'
  order by (serial is null), linked_at desc
  limit 1;
  if v_pin is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'This person has no numeric PIN for that machine.', jsonb_build_object('pin', 'missing'));
  end if;

  if not exists (select 1 from hrms.device_users where serial = v_dev.serial and pin = v_pin) then
    v_user_id := hrms.device_queue(v_actor.org_id, v_dev.serial, 'user_upsert', v_pin, v_emp.id,
      jsonb_build_object('name', coalesce(hrms.device_display_name(v_emp.full_name), v_emp.employee_code), 'privilege', '0'),
      'enroll', v_actor.employee_id);
  end if;
  v_enroll_id := hrms.device_queue(v_actor.org_id, v_dev.serial, 'enroll_face', v_pin, v_emp.id,
    jsonb_build_object('face_type', p_face_type, 'overwrite', case when p_overwrite then '1' else '0' end),
    'enroll', v_actor.employee_id);

  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_command.enroll', 'employee', v_emp.id,
    jsonb_build_object('serial', v_dev.serial, 'pin', v_pin, 'biometric', 'face', 'face_type', p_face_type,
                       'overwrite', p_overwrite, 'command_id', v_enroll_id), 'business', v_emp.id);
  return hrms.ok(jsonb_build_object('command_id', v_enroll_id, 'user_command_id', v_user_id, 'pin', v_pin));
end;
$$;

-- ---------------------------------------------------------------- status
-- Per employee: machines that hold them, waiting commands, last command,
-- last successful finger/face enrolment, and their latest punch photo.
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
                       where c.employee_id = e.id order by c.id desc limit 1),
      'finger_enrolled_at', (select max(c.completed_at) from hrms.device_commands c
                             where c.employee_id = e.id and c.kind = 'enroll_fingerprint' and c.status = 'done'),
      'face_enrolled_at', (select max(c.completed_at) from hrms.device_commands c
                           where c.employee_id = e.id and c.kind = 'enroll_face' and c.status = 'done'),
      'photo_punch_id', (select p.id from hrms.device_punch_events p
                         where p.employee_id = e.id and p.photo_path is not null
                         order by p.device_local_time desc limit 1)
    ))
    from hrms.employees e where e.org_id = v_actor.org_id
  ), '[]'::jsonb));
end;
$$;

revoke all on function hrms.device_forget_employee(uuid, uuid, uuid) from public, anon, authenticated;
select hrms.apply_api_grants();
