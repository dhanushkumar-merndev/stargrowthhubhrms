-- [web-hrms] Ported from ~/Documents/Projects/november/fingertipssl/supabase/migrations/20261111120000_device_management.sql
-- [web-hrms]   unchanged

-- =============================================================================
-- Device management + machine user roster. MOVES INTO THE HRMS UNCHANGED.
--
--   * Admins register / edit / deactivate machines from the dashboard
--     (the serial allowlist) instead of SQL. Serial is immutable once created
--     because punches reference it.
--   * The machine's own user list (PIN + display name + admin flag) is received
--     so HR can see "PIN 7 = PRIYA" when linking. Passwords, card numbers and
--     every fingerprint/face record are dropped by the route and never reach
--     the database.
--   * Still one-way: nothing here sends anything to the machine.
-- =============================================================================

alter table hrms.attendance_devices add column oplog_stamp bigint;

create table hrms.device_users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references hrms.organizations(id) on delete restrict,
  serial text not null references hrms.attendance_devices(serial) on delete restrict,
  pin text not null check (pin ~ '^[0-9A-Za-z]{1,24}$'),
  name text check (char_length(name) <= 80),
  is_device_admin boolean not null default false,
  first_reported_at timestamptz not null default now(),
  last_reported_at timestamptz not null default now(),
  unique (serial, pin)
);
alter table hrms.device_users enable row level security;

-- Gate now also returns the operation-log cursor (user records ride on it).
create or replace function public.internal_device_gate(
  p_secret text, p_serial text, p_token text, p_ip_hash text, p_endpoint text, p_meta jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev hrms.attendance_devices;
  v_dev_id uuid;
  v_code text;
  v_fw text := hrms.clean_text(p_meta ->> 'firmware', 120);
  v_pv text := hrms.clean_text(p_meta ->> 'pushver', 40);
begin
  select a.p_device_id, a.p_code into v_dev_id, v_code
  from hrms.device_authenticate(p_secret, p_serial, p_token, p_ip_hash, left(p_endpoint, 40)) a;
  if v_dev_id is null then
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;
  select * into v_dev from hrms.attendance_devices where id = v_dev_id;
  if (v_fw is not null and v_fw is distinct from v_dev.firmware)
     or (v_pv is not null and v_pv is distinct from v_dev.push_version) then
    update hrms.attendance_devices
       set firmware = coalesce(v_fw, firmware), push_version = coalesce(v_pv, push_version)
     where id = v_dev.id;
  end if;
  return jsonb_build_object(
    'ok', true,
    'org_id', v_dev.org_id,
    'serial', v_dev.serial,
    'attlog_stamp', coalesce(v_dev.attlog_stamp, 0),
    'photo_stamp', coalesce(v_dev.photo_stamp, 0),
    'oplog_stamp', coalesce(v_dev.oplog_stamp, 0)
  );
end;
$$;

-- Machine user roster upsert. p_users: [{pin, name, privilege}] — the route
-- has already removed passwords, card numbers and biometric records.
create or replace function public.internal_ingest_device_users(
  p_secret text, p_serial text, p_token text, p_ip_hash text, p_users jsonb, p_stamp text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev hrms.attendance_devices;
  v_dev_id uuid;
  v_code text;
  rec jsonb;
  v_pin text;
  v_n integer := 0;
  v_bad integer := 0;
begin
  select a.p_device_id, a.p_code into v_dev_id, v_code
  from hrms.device_authenticate(p_secret, p_serial, p_token, p_ip_hash, 'users') a;
  if v_dev_id is null then
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;
  select * into v_dev from hrms.attendance_devices where id = v_dev_id;
  if jsonb_typeof(p_users) is distinct from 'array' or jsonb_array_length(p_users) > 5000 then
    return jsonb_build_object('ok', false, 'code', 'bad_batch');
  end if;

  for rec in select value from jsonb_array_elements(p_users) loop
    v_pin := btrim(coalesce(rec ->> 'pin', ''));
    if v_pin !~ '^[0-9A-Za-z]{1,24}$' then
      v_bad := v_bad + 1;
      continue;
    end if;
    insert into hrms.device_users (org_id, serial, pin, name, is_device_admin)
    values (v_dev.org_id, v_dev.serial, v_pin, hrms.clean_text(rec ->> 'name', 80),
            coalesce(rec ->> 'privilege', '0') not in ('0', ''))
    on conflict (serial, pin) do update
      set name = coalesce(excluded.name, hrms.device_users.name),
          is_device_admin = excluded.is_device_admin,
          last_reported_at = now();
    v_n := v_n + 1;
  end loop;

  update hrms.attendance_devices set
    oplog_stamp = case when coalesce(p_stamp, '') ~ '^\d{1,18}$'
                       then greatest(coalesce(oplog_stamp, 0), p_stamp::bigint) else oplog_stamp end
  where id = v_dev.id;
  return jsonb_build_object('ok', true, 'stored', v_n, 'invalid', v_bad);
end;
$$;

-- Records the operation-log cursor for OPERLOG uploads that carried no users.
create or replace function public.internal_device_oplog_seen(
  p_secret text, p_serial text, p_token text, p_ip_hash text, p_stamp text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev_id uuid;
  v_code text;
begin
  select a.p_device_id, a.p_code into v_dev_id, v_code
  from hrms.device_authenticate(p_secret, p_serial, p_token, p_ip_hash, 'oplog') a;
  if v_dev_id is null then
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;
  update hrms.attendance_devices set
    oplog_stamp = case when coalesce(p_stamp, '') ~ '^\d{1,18}$'
                       then greatest(coalesce(oplog_stamp, 0), p_stamp::bigint) else oplog_stamp end
  where id = v_dev_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- Unmatched queue now carries the name the machine has for that PIN.
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
    select jsonb_agg(jsonb_build_object(
      'serial', g.serial, 'device_label', d.label, 'pin', g.pin, 'punches', g.n,
      'first_local', to_char(g.first_local, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'last_local', to_char(g.last_local, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'last_punch_id', g.last_id, 'with_photo', g.with_photo,
      'machine_name', u.name
    ) order by g.last_local desc)
    from (
      select p.serial, p.pin, count(*) n, min(p.device_local_time) first_local, max(p.device_local_time) last_local,
             (array_agg(p.id order by p.device_local_time desc))[1] last_id,
             count(*) filter (where p.photo_path is not null) with_photo
      from hrms.device_punch_events p
      where p.org_id = v_actor.org_id and p.employee_id is null
      group by p.serial, p.pin
    ) g
    left join hrms.attendance_devices d on d.serial = g.serial
    left join hrms.device_users u on u.serial = g.serial and u.pin = g.pin
  ), '[]'::jsonb));
end;
$$;

-- The machine's roster, with who each PIN is linked to (HR/Admin).
create or replace function public.list_device_users(p_serial text default null) returns jsonb
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
      'serial', u.serial, 'device_label', d.label, 'pin', u.pin, 'name', u.name,
      'is_device_admin', u.is_device_admin, 'last_reported_at', u.last_reported_at,
      'linked_to', (
        select jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name)
        from hrms.device_user_links l join hrms.employees e on e.id = l.employee_id
        where l.org_id = u.org_id and l.pin = u.pin and l.unlinked_at is null
          and (l.serial = u.serial or l.serial is null)
        order by (l.serial is null) limit 1)
    ) order by u.serial, length(u.pin), u.pin)
    from hrms.device_users u
    join hrms.attendance_devices d on d.serial = u.serial
    where u.org_id = v_actor.org_id and (p_serial is null or u.serial = p_serial)
  ), '[]'::jsonb));
end;
$$;

create or replace function public.list_offices() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
begin
  return hrms.ok(coalesce((
    select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) order by o.name)
    from hrms.offices o where o.org_id = v_actor.org_id and o.active
  ), '[]'::jsonb));
end;
$$;

-- Register or edit a machine (Admin only: it changes the ingest allowlist).
-- p_device: {id?, serial (create only), label, office_id, mode, active,
--            token?: new token (>= 16 chars) | "" to remove | absent to keep}
create or replace function public.save_attendance_device(p_device jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  d jsonb := coalesce(p_device, '{}'::jsonb);
  v_id uuid;
  v_old hrms.attendance_devices;
  v_new hrms.attendance_devices;
  v_serial text := upper(btrim(coalesce(d ->> 'serial', '')));
  v_label text := hrms.clean_text(d ->> 'label', 80);
  v_mode text := coalesce(nullif(d ->> 'mode', ''), 'http');
  v_office uuid;
  v_active boolean;
  v_token_hash text;
  v_token_action text := 'keep';
begin
  if not ('admin' = any(v_actor.roles)) then
    perform hrms.raise_error('ACCESS_DENIED', 'Only an Admin can register or change devices.');
  end if;
  begin
    v_id := nullif(d ->> 'id', '')::uuid;
    v_office := nullif(d ->> 'office_id', '')::uuid;
    v_active := coalesce((d ->> 'active')::boolean, true);
  exception when others then
    perform hrms.raise_error('VALIDATION_FAILED', 'Invalid device details.');
  end;
  if v_label is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'Give the device a name.', jsonb_build_object('label', 'required'));
  end if;
  if v_mode not in ('http', 'https') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Transport must be HTTP or HTTPS.', jsonb_build_object('mode', 'invalid'));
  end if;
  if v_office is not null and not exists (select 1 from hrms.offices where id = v_office and org_id = v_actor.org_id) then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown office.', jsonb_build_object('office_id', 'invalid'));
  end if;
  if d ? 'token' then
    if coalesce(d ->> 'token', '') = '' then
      v_token_action := 'remove';
    elsif char_length(d ->> 'token') < 16 then
      perform hrms.raise_error('VALIDATION_FAILED', 'A device token must be at least 16 characters.', jsonb_build_object('token', 'too_short'));
    else
      v_token_action := 'set';
      v_token_hash := hrms.sha256_hex(d ->> 'token');
    end if;
  end if;

  if v_id is null then
    if v_serial !~ '^[A-Z0-9_-]{4,40}$' then
      perform hrms.raise_error('VALIDATION_FAILED', 'Serial numbers are 4–40 letters, digits, - or _.', jsonb_build_object('serial', 'invalid'));
    end if;
    if exists (select 1 from hrms.attendance_devices where serial = v_serial) then
      perform hrms.raise_error('VALIDATION_FAILED', 'That serial is already registered.', jsonb_build_object('serial', 'taken'));
    end if;
    insert into hrms.attendance_devices (org_id, serial, label, office_id, mode, active, token_sha256)
    values (v_actor.org_id, v_serial, v_label, v_office, v_mode, v_active, v_token_hash)
    returning * into v_new;
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device.register', 'attendance_device', v_new.id,
      jsonb_build_object('serial', v_serial, 'label', v_label, 'mode', v_mode, 'active', v_active,
                         'token_set', v_token_hash is not null), 'security');
  else
    select * into v_old from hrms.attendance_devices where id = v_id and org_id = v_actor.org_id for update;
    if v_old.id is null then
      perform hrms.raise_error('NOT_FOUND');
    end if;
    if v_serial <> '' and v_serial <> v_old.serial then
      perform hrms.raise_error('VALIDATION_FAILED', 'A serial cannot be changed; register the new machine instead.',
                               jsonb_build_object('serial', 'immutable'));
    end if;
    update hrms.attendance_devices set
      label = v_label, office_id = v_office, mode = v_mode, active = v_active,
      token_sha256 = case v_token_action when 'set' then v_token_hash when 'remove' then null else token_sha256 end
    where id = v_id
    returning * into v_new;
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device.update', 'attendance_device', v_id,
      jsonb_build_object('serial', v_old.serial,
                         'label', jsonb_build_array(v_old.label, v_new.label),
                         'mode', jsonb_build_array(v_old.mode, v_new.mode),
                         'active', jsonb_build_array(v_old.active, v_new.active),
                         'office_id', jsonb_build_array(v_old.office_id, v_new.office_id),
                         'token', v_token_action), 'security');
  end if;
  return hrms.ok(jsonb_build_object('id', v_new.id, 'serial', v_new.serial));
end;
$$;

-- Devices list gains office id and the roster size.
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

select hrms.apply_api_grants();
