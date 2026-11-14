-- [web-hrms] Ported from ~/Documents/Projects/november/fingertipssl/supabase/migrations/20261111110000_device_attendance.sql
-- [web-hrms]   storage.buckets insert removed (1)

-- =============================================================================
-- Device attendance: eSSL / ZKTeco machines pushing over the iclock (ADMS)
-- protocol. THIS FILE MOVES INTO THE HRMS UNCHANGED (see README "Folding into
-- the HRMS"); it depends only on the hrms.* names listed in the stub migration.
--
-- Trust model
--   * Machine punches are a SEPARATE, LOWER-TRUST source. They never touch
--     hrms.attendance_sessions / attendance_events (the signed phone punches)
--     and every row carries source = 'device'. Turning a device punch into
--     official attendance is a later HRMS step, out of scope here.
--   * A machine "authenticates" only by its serial number in cleartext. The
--     ingest path therefore requires: an allowlisted, active serial; the
--     server-side DEVICE_INGEST_SECRET (proves the request came through our
--     ingest route with the service role); and the per-device token when one
--     is configured. Failures are logged to a bounded rejection table.
--   * The device clock and its in/out status byte are not trusted: received_at
--     is server time, out-of-window times are rejected, and IN/OUT is derived
--     from the order of the person's punches that day.
--   * Fingerprint/face templates are never accepted (the route discards
--     BIODATA and every table other than ATTLOG / ATTPHOTO).
--   * Photos live in the private `device-photos` bucket with NO storage
--     policies: only the service role can read them, and HR/Admin get a
--     short-lived signed URL after hrms authorises (and audits) the view.
--
-- Access model (HRMS house style): tables are in the unexposed `hrms` schema
-- with RLS on and no client policies. Clients use the public.* RPCs below,
-- which scope rows themselves: HR/Admin see their organisation; any other
-- employee sees only their own matched punches; the unmatched queue,
-- rejections, devices and photos are HR/Admin only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

-- Singleton: SHA-256 of DEVICE_INGEST_SECRET (the plaintext is never stored).
create table hrms.device_ingest_settings (
  id boolean primary key default true check (id),
  secret_sha256 text not null check (secret_sha256 ~ '^[0-9a-f]{64}$'),
  rotated_at timestamptz not null default now()
);

-- Serial allowlist and device status.
create table hrms.attendance_devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references hrms.organizations(id) on delete restrict,
  serial text not null unique check (serial ~ '^[A-Za-z0-9_-]{4,40}$'),
  label text not null check (char_length(label) between 1 and 80),
  office_id uuid,
  mode text not null default 'http' check (mode in ('http', 'https')),
  -- Optional per-device token (sent as ?token= or X-Device-Token). Most iclock
  -- firmware cannot send one; when set it is mandatory. Stored hashed.
  token_sha256 text check (token_sha256 ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  last_seen_at timestamptz,
  last_ip_hash text,
  last_punch_received_at timestamptz,
  last_device_time timestamptz,
  firmware text check (char_length(firmware) <= 120),
  push_version text check (char_length(push_version) <= 40),
  -- Device clock minus server clock, estimated from the newest punch of a
  -- batch that arrived within 6 hours. Includes upload lag (seconds).
  clock_drift_seconds integer,
  attlog_stamp bigint,
  photo_stamp bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, office_id) references hrms.offices(org_id, id) on delete restrict
);
create trigger attendance_devices_touch before update on hrms.attendance_devices
  for each row execute function hrms.touch_updated_at();

-- Machine user number (PIN) -> employee. serial NULL = applies to any device.
-- History is kept: a relink closes the old row instead of overwriting it.
create table hrms.device_user_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references hrms.organizations(id) on delete restrict,
  serial text references hrms.attendance_devices(serial) on delete restrict,
  pin text not null check (pin ~ '^[0-9A-Za-z]{1,24}$'),
  employee_id uuid not null,
  linked_by uuid,
  linked_at timestamptz not null default now(),
  unlinked_by uuid,
  unlinked_at timestamptz,
  foreign key (org_id, employee_id) references hrms.employees(org_id, id) on delete restrict
);
create unique index device_user_links_active_uq
  on hrms.device_user_links (org_id, coalesce(serial, ''), pin) where unlinked_at is null;
create index device_user_links_employee_idx on hrms.device_user_links (employee_id) where unlinked_at is null;

-- Append-only punch log. Device-supplied facts are immutable; only the derived
-- columns (match, IN/OUT, counted, photo) may change — see the guard trigger.
create table hrms.device_punch_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references hrms.organizations(id) on delete restrict,
  source text not null default 'device' check (source = 'device'),
  serial text not null references hrms.attendance_devices(serial) on delete restrict,
  pin text not null check (pin ~ '^[0-9A-Za-z]{1,24}$'),
  employee_id uuid,
  link_id uuid references hrms.device_user_links(id) on delete restrict,
  matched_at timestamptz,
  -- Derived from the order of this person's punches that local day (1st IN,
  -- 2nd OUT, ...). A repeat scan within 60 s of the previous counted punch is
  -- kept but not counted, and shows the previous punch's action.
  action_effective text not null check (action_effective in ('IN', 'OUT')),
  counted boolean not null default true,
  device_time timestamptz not null,             -- device wall clock, read as org timezone
  device_local_time timestamp not null,          -- exactly what the device sent
  received_at timestamptz not null default now(),-- trusted server time
  verify_mode smallint,                          -- 1 fingerprint, 15 face, 0 password, ...
  photo_path text,
  dedupe_hash text not null unique check (dedupe_hash ~ '^[0-9a-f]{64}$'),
  -- claimed_status (untrusted), work_code, inactive-employee flag, ip hash, line no.
  integrity jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (org_id, employee_id) references hrms.employees(org_id, id) on delete restrict
);
create index device_punch_events_feed_idx on hrms.device_punch_events (org_id, received_at desc, id desc);
create index device_punch_events_emp_day_idx on hrms.device_punch_events (org_id, employee_id, device_local_time);
create index device_punch_events_unmatched_idx on hrms.device_punch_events (org_id, pin, device_local_time)
  where employee_id is null;
create index device_punch_events_photo_idx on hrms.device_punch_events (serial, pin, device_local_time);

-- Punch photos. They arrive in their own requests, before or after the punch,
-- and are joined to it on (serial, pin, device_local_time).
create table hrms.device_punch_photos (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references hrms.organizations(id) on delete restrict,
  serial text not null references hrms.attendance_devices(serial) on delete restrict,
  pin text not null check (pin ~ '^[0-9A-Za-z]{1,24}$'),
  device_local_time timestamp not null,
  storage_path text not null unique check (char_length(storage_path) <= 300),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null check (size_bytes between 1 and 2097152),
  punch_id uuid references hrms.device_punch_events(id) on delete restrict,
  received_at timestamptz not null default now(),
  purged_at timestamptz,
  unique (serial, pin, device_local_time)
);
create index device_punch_photos_retention_idx on hrms.device_punch_photos (received_at) where purged_at is null;

-- Bounded security log of refused device traffic (see hrms.device_reject).
create table hrms.device_ingest_rejections (
  id bigint generated always as identity primary key,
  org_id uuid,
  serial text check (char_length(serial) <= 64),
  code text not null check (char_length(code) <= 40),
  detail jsonb,
  ip_hash text check (char_length(ip_hash) <= 64),
  created_at timestamptz not null default now()
);
create index device_ingest_rejections_time_idx on hrms.device_ingest_rejections (created_at desc);
create index device_ingest_rejections_ip_idx on hrms.device_ingest_rejections (ip_hash, created_at desc);

-- -----------------------------------------------------------------------------
-- Integrity guards
-- -----------------------------------------------------------------------------

create or replace function hrms.device_punch_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'HRMS: device punches are append-only' using errcode = '42501';
  end if;
  if (new.id, new.org_id, new.source, new.serial, new.pin, new.device_time, new.device_local_time,
      new.received_at, new.verify_mode, new.dedupe_hash, new.integrity, new.created_at)
     is distinct from
     (old.id, old.org_id, old.source, old.serial, old.pin, old.device_time, old.device_local_time,
      old.received_at, old.verify_mode, old.dedupe_hash, old.integrity, old.created_at) then
    raise exception 'HRMS: device-supplied punch fields are immutable' using errcode = '42501';
  end if;
  if old.employee_id is not null and new.employee_id is distinct from old.employee_id then
    raise exception 'HRMS: a matched device punch cannot be re-assigned' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger device_punch_events_guard before update or delete on hrms.device_punch_events
  for each row execute function hrms.device_punch_guard();
create trigger device_punch_events_no_truncate before truncate on hrms.device_punch_events
  for each statement execute function hrms.forbid_mutation();

-- -----------------------------------------------------------------------------
-- Internal helpers
-- -----------------------------------------------------------------------------

create or replace function hrms.sha256_hex(p text) returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(coalesce(p, ''), 'UTF8'), 'sha256'), 'hex');
$$;

-- Bounded rejection log: at most 200 rows per source (ip hash) per 10 minutes,
-- 30-day retention, 20 000-row ceiling. Never raises.
create or replace function hrms.device_reject(
  p_org uuid, p_serial text, p_code text, p_detail jsonb, p_ip_hash text
) returns void
language plpgsql
set search_path = ''
as $$
declare
  v_recent integer;
begin
  select count(*) into v_recent from hrms.device_ingest_rejections
  where ip_hash is not distinct from left(p_ip_hash, 64) and created_at > now() - interval '10 minutes';
  if v_recent >= 200 then
    return;
  end if;
  insert into hrms.device_ingest_rejections (org_id, serial, code, detail, ip_hash)
  values (p_org, left(hrms.clean_text(p_serial, 64), 64), left(p_code, 40), hrms.redact(p_detail), left(p_ip_hash, 64));
  if random() < 0.02 then
    delete from hrms.device_ingest_rejections where created_at < now() - interval '30 days';
    delete from hrms.device_ingest_rejections
    where id <= (select id from hrms.device_ingest_rejections order by id desc offset 20000 limit 1);
  end if;
exception when others then
  null; -- logging must never break ingest
end;
$$;

-- Authenticates a device request. Returns the device id, or NULL after
-- logging a rejection; p_code then carries the reason.
create or replace function hrms.device_authenticate(
  p_secret text, p_serial text, p_token text, p_ip_hash text, p_endpoint text,
  out p_device_id uuid, out p_code text
)
language plpgsql
set search_path = ''
as $$
declare
  v_serial text := btrim(coalesce(p_serial, ''));
  v_dev hrms.attendance_devices;
begin
  p_device_id := null;
  p_code := null;
  if coalesce(p_secret, '') = '' or not exists (
       select 1 from hrms.device_ingest_settings where secret_sha256 = hrms.sha256_hex(p_secret)) then
    p_code := 'bad_secret';
    perform hrms.device_reject(null, v_serial, p_code, jsonb_build_object('endpoint', p_endpoint), p_ip_hash);
    perform hrms.security_event(null, null, 'device.bad_ingest_secret', jsonb_build_object('endpoint', p_endpoint), p_ip_hash);
    return;
  end if;
  if v_serial !~ '^[A-Za-z0-9_-]{4,40}$' then
    p_code := 'bad_serial';
    perform hrms.device_reject(null, v_serial, p_code, jsonb_build_object('endpoint', p_endpoint), p_ip_hash);
    return;
  end if;
  select * into v_dev from hrms.attendance_devices where serial = v_serial;
  if v_dev.id is null then
    p_code := 'unknown_serial';
    perform hrms.device_reject(null, v_serial, p_code, jsonb_build_object('endpoint', p_endpoint), p_ip_hash);
    return;
  end if;
  if not v_dev.active then
    p_code := 'inactive_device';
    perform hrms.device_reject(v_dev.org_id, v_serial, p_code, jsonb_build_object('endpoint', p_endpoint), p_ip_hash);
    return;
  end if;
  if v_dev.token_sha256 is not null
     and (coalesce(p_token, '') = '' or hrms.sha256_hex(p_token) <> v_dev.token_sha256) then
    p_code := 'bad_token';
    perform hrms.device_reject(v_dev.org_id, v_serial, p_code, jsonb_build_object('endpoint', p_endpoint), p_ip_hash);
    return;
  end if;
  -- Heartbeat (throttled to one write per 15 s per device).
  if v_dev.last_seen_at is null or v_dev.last_seen_at < now() - interval '15 seconds'
     or v_dev.last_ip_hash is distinct from left(p_ip_hash, 64) then
    update hrms.attendance_devices set last_seen_at = now(), last_ip_hash = left(p_ip_hash, 64)
    where id = v_dev.id;
  end if;
  p_device_id := v_dev.id;
end;
$$;

-- Recomputes IN/OUT and `counted` for one person's punches on one local day:
-- an employee's punches when p_employee is set, else the unmatched punches of
-- p_pin. Rows are only written when something changes.
create or replace function hrms.device_resequence(p_org uuid, p_employee uuid, p_pin text, p_day date)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
  v_last_counted timestamptz;
  v_prev_action text;
  v_action text;
  v_counted boolean;
begin
  for r in
    select id, device_time, action_effective, counted
    from hrms.device_punch_events
    where org_id = p_org
      and device_local_time >= p_day::timestamp
      and device_local_time < (p_day + 1)::timestamp
      and case when p_employee is not null then employee_id = p_employee
               else employee_id is null and pin = p_pin end
    order by device_time, id
  loop
    if v_last_counted is not null and r.device_time - v_last_counted < interval '60 seconds' then
      v_action := v_prev_action;
      v_counted := false;
    else
      v_n := v_n + 1;
      v_action := case when v_n % 2 = 1 then 'IN' else 'OUT' end;
      v_counted := true;
      v_last_counted := r.device_time;
      v_prev_action := v_action;
    end if;
    if r.action_effective is distinct from v_action or r.counted is distinct from v_counted then
      update hrms.device_punch_events set action_effective = v_action, counted = v_counted where id = r.id;
    end if;
  end loop;
end;
$$;

-- Serialises every writer of an organisation's device punches so IN/OUT
-- sequencing always sees committed neighbours (tiny volume: ~20 people).
create or replace function hrms.device_lock_org(p_org uuid) returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('hrms.device_punches:' || p_org::text, 0));
$$;

-- -----------------------------------------------------------------------------
-- Ingest RPCs (service role only; called by the Next.js /iclock route)
-- -----------------------------------------------------------------------------

-- Stores/rotates the ingest secret hash. Run once by scripts/setup-demo.ts.
create or replace function public.internal_configure_device_ingest(p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(coalesce(p_secret, '')) < 32 then
    perform hrms.raise_error('VALIDATION_FAILED', 'DEVICE_INGEST_SECRET must be at least 32 characters.');
  end if;
  insert into hrms.device_ingest_settings (id, secret_sha256, rotated_at)
  values (true, hrms.sha256_hex(p_secret), now())
  on conflict (id) do update set secret_sha256 = excluded.secret_sha256, rotated_at = now()
  where hrms.device_ingest_settings.secret_sha256 is distinct from excluded.secret_sha256;
  if found then
    perform hrms.security_event(null, null, 'device.ingest_secret_set', null, null);
  end if;
end;
$$;

-- Handshake / heartbeat / command-poll gate. Returns cursors for the options
-- block; never raises for an unauthorised device (it logs and returns ok=false).
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
  select * into v_dev from hrms.attendance_devices where id = v_dev_id;
  if v_dev_id is null then
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;
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
    'photo_stamp', coalesce(v_dev.photo_stamp, 0)
  );
end;
$$;

-- ATTLOG batch ingest. p_records: [{line, pin, device_time 'YYYY-MM-DD HH:MM:SS',
-- status, verify, work_code}] or {line, error, raw} for lines the route could
-- not parse (logged here so the database keeps the record of what was refused).
-- Every record is consumed exactly once: accepted, duplicate (a resend) or
-- rejected (logged). The route ACKs `processed`, so a refused line is never
-- resent forever.
create or replace function public.internal_ingest_device_punches(
  p_secret text, p_serial text, p_token text, p_ip_hash text, p_records jsonb, p_stamp text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev hrms.attendance_devices;
  v_dev_id uuid;
  v_code text;
  v_tz text;
  rec jsonb;
  v_pin text;
  v_raw_time text;
  v_local timestamp;
  v_time timestamptz;
  v_status smallint;
  v_verify smallint;
  v_hash text;
  v_link record;
  v_inactive boolean;
  v_id uuid;
  v_photo text;
  v_processed integer := 0;
  v_accepted integer := 0;
  v_duplicates integer := 0;
  v_rejected integer := 0;
  v_ids uuid[] := array[]::uuid[];
  v_emp_days text[] := array[]::text[];
  v_pin_days text[] := array[]::text[];
  v_newest timestamptz;
  v_key text;
begin
  select a.p_device_id, a.p_code into v_dev_id, v_code
  from hrms.device_authenticate(p_secret, p_serial, p_token, p_ip_hash, 'attlog') a;
  select * into v_dev from hrms.attendance_devices where id = v_dev_id;
  if v_dev_id is null then
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;
  if jsonb_typeof(p_records) is distinct from 'array' or jsonb_array_length(p_records) > 5000 then
    perform hrms.device_reject(v_dev.org_id, v_dev.serial, 'bad_batch', null, p_ip_hash);
    return jsonb_build_object('ok', false, 'code', 'bad_batch');
  end if;

  perform hrms.device_lock_org(v_dev.org_id);
  select timezone into v_tz from hrms.organizations where id = v_dev.org_id;

  for rec in select value from jsonb_array_elements(p_records) loop
    v_processed := v_processed + 1;

    if rec ? 'error' then
      v_rejected := v_rejected + 1;
      perform hrms.device_reject(v_dev.org_id, v_dev.serial, 'malformed_line',
        jsonb_build_object('line', rec -> 'line', 'error', left(rec ->> 'error', 60),
                           'raw', hrms.clean_text(rec ->> 'raw', 200)), p_ip_hash);
      continue;
    end if;

    v_pin := btrim(coalesce(rec ->> 'pin', ''));
    v_raw_time := btrim(coalesce(rec ->> 'device_time', ''));
    if v_pin !~ '^[0-9A-Za-z]{1,24}$' then
      v_rejected := v_rejected + 1;
      perform hrms.device_reject(v_dev.org_id, v_dev.serial, 'bad_pin',
        jsonb_build_object('line', rec -> 'line', 'pin', hrms.clean_text(v_pin, 40)), p_ip_hash);
      continue;
    end if;

    v_local := null;
    if v_raw_time ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$' then
      begin
        v_local := v_raw_time::timestamp;
      exception when others then
        v_local := null;
      end;
    end if;
    if v_local is null then
      v_rejected := v_rejected + 1;
      perform hrms.device_reject(v_dev.org_id, v_dev.serial, 'bad_time',
        jsonb_build_object('line', rec -> 'line', 'pin', v_pin, 'device_time', hrms.clean_text(v_raw_time, 40)), p_ip_hash);
      continue;
    end if;

    v_time := v_local at time zone v_tz;
    -- Window: up to 15 min ahead (clock drift) and 35 days back (offline backlog).
    -- Refused punches keep pin + time in the log so HR can recover them.
    if v_time > now() + interval '15 minutes' or v_time < now() - interval '35 days' then
      v_rejected := v_rejected + 1;
      perform hrms.device_reject(v_dev.org_id, v_dev.serial,
        case when v_time > now() then 'future_time' else 'stale_time' end,
        jsonb_build_object('line', rec -> 'line', 'pin', v_pin, 'device_time', v_raw_time), p_ip_hash);
      continue;
    end if;

    v_status := case when coalesce(rec ->> 'status', '') ~ '^\d{1,3}$' and (rec ->> 'status')::int <= 255
                     then (rec ->> 'status')::smallint end;
    v_verify := case when coalesce(rec ->> 'verify', '') ~ '^\d{1,3}$' and (rec ->> 'verify')::int <= 255
                     then (rec ->> 'verify')::smallint end;
    v_hash := hrms.sha256_hex(v_dev.serial || '|' || v_pin || '|' || to_char(v_local, 'YYYY-MM-DD HH24:MI:SS'));

    -- Best-effort match: a device-specific link wins over an any-device link.
    select l.id, l.employee_id, e.status into v_link
    from hrms.device_user_links l
    join hrms.employees e on e.id = l.employee_id
    where l.org_id = v_dev.org_id and l.pin = v_pin and l.unlinked_at is null
      and (l.serial = v_dev.serial or l.serial is null)
    order by (l.serial is null), l.linked_at desc
    limit 1;
    v_inactive := v_link.employee_id is not null and v_link.status <> 'active';

    insert into hrms.device_punch_events (
      org_id, serial, pin, employee_id, link_id, matched_at, action_effective,
      device_time, device_local_time, verify_mode, dedupe_hash, integrity
    ) values (
      v_dev.org_id, v_dev.serial, v_pin, v_link.employee_id, v_link.id,
      case when v_link.employee_id is not null then now() end, 'IN',
      v_time, v_local, v_verify, v_hash,
      jsonb_strip_nulls(jsonb_build_object(
        'claimed_status', v_status,
        'work_code', hrms.clean_text(rec ->> 'work_code', 24),
        'employee_inactive', case when v_inactive then true end,
        'line', rec -> 'line',
        'ip_hash', left(p_ip_hash, 16)
      ))
    )
    on conflict (dedupe_hash) do nothing
    returning id into v_id;

    if v_id is null then
      v_duplicates := v_duplicates + 1;
      continue;
    end if;

    v_accepted := v_accepted + 1;
    v_ids := v_ids || v_id;
    v_newest := greatest(v_newest, v_time);
    if v_link.employee_id is not null then
      v_emp_days := v_emp_days || (v_link.employee_id::text || '|' || v_local::date::text);
    else
      v_pin_days := v_pin_days || (v_pin || '|' || v_local::date::text);
    end if;

    -- A photo that arrived before its punch is attached now.
    update hrms.device_punch_photos set punch_id = v_id
    where serial = v_dev.serial and pin = v_pin and device_local_time = v_local
      and punch_id is null and purged_at is null
    returning storage_path into v_photo;
    if v_photo is not null then
      update hrms.device_punch_events set photo_path = v_photo where id = v_id;
      v_photo := null;
    end if;
  end loop;

  for v_key in select distinct k from unnest(v_emp_days) k loop
    perform hrms.device_resequence(v_dev.org_id, split_part(v_key, '|', 1)::uuid, null, split_part(v_key, '|', 2)::date);
  end loop;
  for v_key in select distinct k from unnest(v_pin_days) k loop
    perform hrms.device_resequence(v_dev.org_id, null, split_part(v_key, '|', 1), split_part(v_key, '|', 2)::date);
  end loop;

  update hrms.attendance_devices set
    attlog_stamp = case when coalesce(p_stamp, '') ~ '^\d{1,18}$'
                        then greatest(coalesce(attlog_stamp, 0), p_stamp::bigint) else attlog_stamp end,
    last_punch_received_at = case when v_accepted > 0 then now() else last_punch_received_at end,
    clock_drift_seconds = case
      when v_newest is not null and v_newest > coalesce(last_device_time, '-infinity'::timestamptz)
           and abs(extract(epoch from v_newest - now())) < 6 * 3600
      then round(extract(epoch from v_newest - now()))::integer
      else clock_drift_seconds end,
    last_device_time = greatest(last_device_time, v_newest)
  where id = v_dev.id;

  return jsonb_build_object('ok', true, 'processed', v_processed, 'accepted', v_accepted,
                            'duplicates', v_duplicates, 'rejected', v_rejected, 'ids', to_jsonb(v_ids));
end;
$$;

-- Single-punch form of the above (same validation, dedupe and sequencing).
-- Photos are attached separately because devices upload them in their own
-- requests; see internal_attach_device_photo.
create or replace function public.internal_ingest_device_punch(
  p_secret text, p_serial text, p_pin text, p_device_time text, p_status text, p_verify text,
  p_token text default null, p_ip_hash text default null
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.internal_ingest_device_punches(
    p_secret, p_serial, p_token, p_ip_hash,
    jsonb_build_array(jsonb_build_object('line', 1, 'pin', p_pin, 'device_time', p_device_time,
                                         'status', p_status, 'verify', p_verify)),
    null);
$$;

-- Records a stored punch photo and joins it to its punch (now or on arrival).
-- The route uploads to `<org_id>/<serial>/<YYYY-MM-DD>/<pin>-<HHMMSS>-<sha8>.jpg`
-- after internal_device_gate succeeds; this re-authenticates and validates it.
create or replace function public.internal_attach_device_photo(
  p_secret text, p_serial text, p_token text, p_ip_hash text,
  p_pin text, p_device_time text, p_storage_path text, p_sha256 text, p_size_bytes integer,
  p_stamp text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dev hrms.attendance_devices;
  v_dev_id uuid;
  v_code text;
  v_tz text;
  v_local timestamp;
  v_time timestamptz;
  v_pin text := btrim(coalesce(p_pin, ''));
  v_photo_id uuid;
  v_punch uuid;
  v_expected text;
begin
  select a.p_device_id, a.p_code into v_dev_id, v_code
  from hrms.device_authenticate(p_secret, p_serial, p_token, p_ip_hash, 'attphoto') a;
  select * into v_dev from hrms.attendance_devices where id = v_dev_id;
  if v_dev_id is null then
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;
  select timezone into v_tz from hrms.organizations where id = v_dev.org_id;

  begin
    v_local := case when btrim(coalesce(p_device_time, '')) ~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$'
                    then btrim(p_device_time)::timestamp end;
  exception when others then
    v_local := null;
  end;
  if v_pin !~ '^[0-9A-Za-z]{1,24}$' or v_local is null
     or coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_size_bytes, 0) not between 1 and 2097152 then
    perform hrms.device_reject(v_dev.org_id, v_dev.serial, 'bad_photo',
      jsonb_build_object('pin', hrms.clean_text(v_pin, 40), 'device_time', hrms.clean_text(p_device_time, 40)), p_ip_hash);
    return jsonb_build_object('ok', false, 'code', 'bad_photo');
  end if;
  v_time := v_local at time zone v_tz;
  if v_time > now() + interval '15 minutes' or v_time < now() - interval '35 days' then
    perform hrms.device_reject(v_dev.org_id, v_dev.serial, 'photo_out_of_window',
      jsonb_build_object('pin', v_pin, 'device_time', p_device_time), p_ip_hash);
    return jsonb_build_object('ok', false, 'code', 'photo_out_of_window');
  end if;
  v_expected := v_dev.org_id::text || '/' || v_dev.serial || '/' || to_char(v_local, 'YYYY-MM-DD') || '/'
                || v_pin || '-' || to_char(v_local, 'HH24MISS') || '-' || left(p_sha256, 8) || '.jpg';
  if p_storage_path is distinct from v_expected then
    perform hrms.device_reject(v_dev.org_id, v_dev.serial, 'bad_photo_path', null, p_ip_hash);
    return jsonb_build_object('ok', false, 'code', 'bad_photo_path');
  end if;

  perform hrms.device_lock_org(v_dev.org_id);
  insert into hrms.device_punch_photos (org_id, serial, pin, device_local_time, storage_path, sha256, size_bytes)
  values (v_dev.org_id, v_dev.serial, v_pin, v_local, p_storage_path, p_sha256, p_size_bytes)
  on conflict (serial, pin, device_local_time) do nothing
  returning id into v_photo_id;
  if v_photo_id is null then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  select id into v_punch from hrms.device_punch_events
  where serial = v_dev.serial and pin = v_pin and device_local_time = v_local;
  if v_punch is not null then
    update hrms.device_punch_photos set punch_id = v_punch where id = v_photo_id;
    update hrms.device_punch_events set photo_path = p_storage_path where id = v_punch and photo_path is null;
  end if;

  update hrms.attendance_devices set
    photo_stamp = case when coalesce(p_stamp, '') ~ '^\d{1,18}$'
                       then greatest(coalesce(photo_stamp, 0), p_stamp::bigint) else photo_stamp end
  where id = v_dev.id;

  return jsonb_build_object('ok', true, 'duplicate', false, 'punch_id', v_punch);
end;
$$;

-- Logs refused traffic the route rejects before any other RPC (e.g. a BIODATA
-- upload or an oversized body). Authenticates the secret, not the device.
create or replace function public.internal_log_device_rejection(
  p_secret text, p_serial text, p_code text, p_detail jsonb, p_ip_hash text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if not exists (select 1 from hrms.device_ingest_settings where secret_sha256 = hrms.sha256_hex(coalesce(p_secret, ''))) then
    return;
  end if;
  select org_id into v_org from hrms.attendance_devices where serial = btrim(coalesce(p_serial, ''));
  perform hrms.device_reject(v_org, p_serial, p_code, p_detail, p_ip_hash);
end;
$$;

-- Photo retention: claim photos older than p_days (the cron route deletes the
-- objects, then calls internal_device_photo_purge_done).
create or replace function public.internal_device_photo_purge_claim(p_secret text, p_days integer, p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from hrms.device_ingest_settings where secret_sha256 = hrms.sha256_hex(coalesce(p_secret, ''))) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  if p_days is null or p_days < 1 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Retention must be at least one day.');
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'path', storage_path))
    from (select id, storage_path from hrms.device_punch_photos
          where purged_at is null and received_at < now() - make_interval(days => p_days)
          order by received_at limit least(greatest(coalesce(p_limit, 200), 1), 1000)) s
  ), '[]'::jsonb);
end;
$$;

create or replace function public.internal_device_photo_purge_done(p_secret text, p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if not exists (select 1 from hrms.device_ingest_settings where secret_sha256 = hrms.sha256_hex(coalesce(p_secret, ''))) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  update hrms.device_punch_events p set photo_path = null
  from hrms.device_punch_photos f
  where f.id = any(p_ids) and f.punch_id = p.id and p.photo_path = f.storage_path;
  update hrms.device_punch_photos set purged_at = now() where id = any(p_ids) and purged_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- -----------------------------------------------------------------------------
-- Dashboard RPCs (authenticated; each resolves the actor first)
-- -----------------------------------------------------------------------------

create or replace function hrms.require_hr_admin() returns hrms.actor
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
begin
  if not hrms.is_hr_or_admin(v_actor) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  return v_actor;
end;
$$;

create or replace function public.get_device_console_context() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_emp hrms.employees;
begin
  select * into v_emp from hrms.employees where id = v_actor.employee_id;
  return hrms.ok(jsonb_build_object(
    'employee', jsonb_build_object('id', v_emp.id, 'code', v_emp.employee_code, 'name', v_emp.full_name),
    'org_id', v_actor.org_id,
    'role', case when 'admin' = any(v_actor.roles) then 'admin'
                 when 'hr' = any(v_actor.roles) then 'hr' else 'employee' end,
    'can_manage', hrms.is_hr_or_admin(v_actor),
    'realtime_topic', 'hrms:device-punches:' || v_actor.org_id::text
  ));
end;
$$;

-- Used by the realtime.messages policy. Never raises.
create or replace function public.device_feed_can_listen(p_topic text) returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor;
begin
  v_actor := hrms.current_actor();
  return hrms.is_hr_or_admin(v_actor) and p_topic = 'hrms:device-punches:' || v_actor.org_id::text;
exception when others then
  return false;
end;
$$;

-- Punch feed. p_filters: {ids[], employee_id, serial, unmatched, from, to
-- (local dates, inclusive), limit (1–200), before_received_at + before_id}.
-- HR/Admin: the organisation. Anyone else: only their own matched punches,
-- without PIN, photo or integrity detail.
create or replace function public.list_device_punches(p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_hr boolean := hrms.is_hr_or_admin(v_actor);
  f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_ids uuid[];
  v_emp uuid;
  v_serial text;
  v_unmatched boolean;
  v_from date;
  v_to date;
  v_limit integer;
  v_before_at timestamptz;
  v_before_id uuid;
begin
  begin
    if jsonb_typeof(f -> 'ids') = 'array' then
      select array_agg(x::uuid) into v_ids from (select jsonb_array_elements_text(f -> 'ids') x limit 100) s;
    end if;
    v_emp := nullif(f ->> 'employee_id', '')::uuid;
    v_serial := nullif(btrim(f ->> 'serial'), '');
    v_unmatched := coalesce((f ->> 'unmatched')::boolean, false);
    v_from := nullif(f ->> 'from', '')::date;
    v_to := nullif(f ->> 'to', '')::date;
    v_limit := least(greatest(coalesce((f ->> 'limit')::integer, 50), 1), 200);
    v_before_at := nullif(f ->> 'before_received_at', '')::timestamptz;
    v_before_id := nullif(f ->> 'before_id', '')::uuid;
  exception when others then
    perform hrms.raise_error('VALIDATION_FAILED', 'Invalid filter.');
  end;

  return hrms.ok(coalesce((
    select jsonb_agg(row_json order by received_at desc, id desc)
    from (
      select p.received_at, p.id, jsonb_build_object(
        'id', p.id,
        'source', p.source,
        'serial', p.serial,
        'device_label', d.label,
        'pin', case when v_hr then p.pin end,
        'employee', case when e.id is not null then
          jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name) end,
        'action', p.action_effective,
        'counted', p.counted,
        'device_time', p.device_time,
        'device_local_time', to_char(p.device_local_time, 'YYYY-MM-DD"T"HH24:MI:SS'),
        'received_at', p.received_at,
        'verify_mode', p.verify_mode,
        'has_photo', v_hr and p.photo_path is not null,
        'integrity', case when v_hr then p.integrity end
      ) as row_json
      from hrms.device_punch_events p
      left join hrms.employees e on e.id = p.employee_id
      left join hrms.attendance_devices d on d.serial = p.serial
      where p.org_id = v_actor.org_id
        and (v_hr or p.employee_id = v_actor.employee_id)
        and (v_ids is null or p.id = any(v_ids))
        and (v_emp is null or p.employee_id = v_emp)
        and (v_serial is null or p.serial = v_serial)
        and (not v_unmatched or (v_hr and p.employee_id is null))
        and (v_from is null or p.device_local_time >= v_from::timestamp)
        and (v_to is null or p.device_local_time < (v_to + 1)::timestamp)
        and (v_before_at is null or (p.received_at, p.id) < (v_before_at, coalesce(v_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
      order by p.received_at desc, p.id desc
      limit v_limit
    ) s
  ), '[]'::jsonb));
end;
$$;

-- Unmatched queue grouped by device + PIN.
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
      'last_punch_id', g.last_id, 'with_photo', g.with_photo
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
  ), '[]'::jsonb));
end;
$$;

create or replace function public.list_device_link_candidates() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
begin
  return hrms.ok(coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name)
                     order by e.full_name)
    from hrms.employees e
    where e.org_id = v_actor.org_id and e.status = 'active'
  ), '[]'::jsonb));
end;
$$;

-- Links a machine PIN to an employee (HR/Admin, audited) and attaches that
-- PIN's unmatched punches. p_serial NULL = the PIN means this person on every
-- device. Relinking a PIN closes the previous link; punches already matched
-- stay with whoever they were matched to.
create or replace function public.link_device_user(p_pin text, p_employee_id uuid, p_serial text default null)
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
  v_old hrms.device_user_links;
  v_link_id uuid;
  v_attached integer := 0;
  r record;
begin
  if v_pin !~ '^[0-9A-Za-z]{1,24}$' then
    perform hrms.raise_error('VALIDATION_FAILED', 'Machine user numbers are 1–24 letters or digits.',
                             jsonb_build_object('pin', 'invalid'));
  end if;
  select * into v_emp from hrms.employees where id = p_employee_id and org_id = v_actor.org_id;
  if v_emp.id is null or v_emp.status <> 'active' then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose an active employee.', jsonb_build_object('employee_id', 'invalid'));
  end if;
  if v_serial is not null and not exists (
    select 1 from hrms.attendance_devices where serial = v_serial and org_id = v_actor.org_id) then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown device.', jsonb_build_object('serial', 'invalid'));
  end if;

  perform hrms.device_lock_org(v_actor.org_id);

  select * into v_old from hrms.device_user_links
  where org_id = v_actor.org_id and coalesce(serial, '') = coalesce(v_serial, '') and pin = v_pin
    and unlinked_at is null
  for update;
  if v_old.id is not null and v_old.employee_id = v_emp.id then
    v_link_id := v_old.id;
  else
    if v_old.id is not null then
      update hrms.device_user_links set unlinked_at = now(), unlinked_by = v_actor.employee_id where id = v_old.id;
      perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_user.unlink', 'device_user_link', v_old.id,
        jsonb_build_object('pin', v_pin, 'serial', v_serial, 'employee_id', v_old.employee_id, 'reason', 'relinked'),
        'business', v_old.employee_id);
    end if;
    insert into hrms.device_user_links (org_id, serial, pin, employee_id, linked_by)
    values (v_actor.org_id, v_serial, v_pin, v_emp.id, v_actor.employee_id)
    returning id into v_link_id;
  end if;

  for r in
    update hrms.device_punch_events
       set employee_id = v_emp.id, link_id = v_link_id, matched_at = now()
     where org_id = v_actor.org_id and pin = v_pin and employee_id is null
       and (v_serial is null or serial = v_serial)
    returning device_local_time::date as day
  loop
    v_attached := v_attached + 1;
  end loop;

  for r in
    select distinct device_local_time::date as day from hrms.device_punch_events
    where link_id = v_link_id and employee_id = v_emp.id
  loop
    perform hrms.device_resequence(v_actor.org_id, v_emp.id, null, r.day);
  end loop;

  -- A repeat of an existing link that attached nothing is a no-op: not audited.
  if v_old.id is distinct from v_link_id or v_attached > 0 then
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_user.link', 'device_user_link', v_link_id,
      jsonb_build_object('pin', v_pin, 'serial', v_serial, 'employee_id', v_emp.id, 'attached_punches', v_attached),
      'business', v_emp.id);
  end if;

  return hrms.ok(jsonb_build_object('link_id', v_link_id, 'attached', v_attached));
end;
$$;

create or replace function public.unlink_device_user(p_link_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_link hrms.device_user_links;
begin
  update hrms.device_user_links set unlinked_at = now(), unlinked_by = v_actor.employee_id
  where id = p_link_id and org_id = v_actor.org_id and unlinked_at is null
  returning * into v_link;
  if v_link.id is null then
    perform hrms.raise_error('NOT_FOUND');
  end if;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_user.unlink', 'device_user_link', v_link.id,
    jsonb_build_object('pin', v_link.pin, 'serial', v_link.serial, 'employee_id', v_link.employee_id),
    'business', v_link.employee_id);
  return hrms.ok(jsonb_build_object('link_id', v_link.id));
end;
$$;

create or replace function public.list_device_user_links() returns jsonb
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
      'id', l.id, 'pin', l.pin, 'serial', l.serial, 'device_label', d.label,
      'employee', jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name),
      'linked_at', l.linked_at
    ) order by l.pin, l.serial nulls first)
    from hrms.device_user_links l
    join hrms.employees e on e.id = l.employee_id
    left join hrms.attendance_devices d on d.serial = l.serial
    where l.org_id = v_actor.org_id and l.unlinked_at is null
  ), '[]'::jsonb));
end;
$$;

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
      'id', d.id, 'serial', d.serial, 'label', d.label, 'office', o.name, 'mode', d.mode,
      'active', d.active, 'has_token', d.token_sha256 is not null,
      'last_seen_at', d.last_seen_at, 'last_punch_received_at', d.last_punch_received_at,
      'firmware', d.firmware, 'push_version', d.push_version,
      'clock_drift_seconds', d.clock_drift_seconds,
      'punches_today', (select count(*) from hrms.device_punch_events p
                        where p.serial = d.serial
                          and p.device_local_time >= (now() at time zone org.timezone)::date::timestamp),
      'rejections_24h', (select count(*) from hrms.device_ingest_rejections r
                         where r.serial = d.serial and r.created_at > now() - interval '24 hours')
    ) order by d.label)
    from hrms.attendance_devices d
    join hrms.organizations org on org.id = d.org_id
    left join hrms.offices o on o.id = d.office_id
    where d.org_id = v_actor.org_id
  ), '[]'::jsonb));
end;
$$;

-- Recent rejections for the organisation, plus traffic from serials that are
-- not registered anywhere (org unknown by definition).
create or replace function public.list_device_ingest_rejections(p_limit integer default 50) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
begin
  return hrms.ok(coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'serial', r.serial, 'code', r.code, 'detail', r.detail,
                                        'created_at', r.created_at) order by r.id desc)
    from (select * from hrms.device_ingest_rejections
          where org_id = v_actor.org_id or org_id is null
          order by id desc limit least(greatest(coalesce(p_limit, 50), 1), 200)) r
  ), '[]'::jsonb));
end;
$$;

-- Authorises one photo view (HR/Admin) and audits it. The caller (a server
-- route holding the service role) then mints a short-lived signed URL.
create or replace function public.authorize_device_photo(p_punch_id uuid) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.require_hr_admin();
  v_p hrms.device_punch_events;
begin
  select * into v_p from hrms.device_punch_events where id = p_punch_id and org_id = v_actor.org_id;
  if v_p.id is null or v_p.photo_path is null then
    perform hrms.raise_error('NOT_FOUND');
  end if;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'device_photo.view', 'device_punch', v_p.id,
                     null, 'access', v_p.employee_id);
  return hrms.ok(jsonb_build_object('bucket', 'device-photos', 'path', v_p.photo_path));
end;
$$;

-- -----------------------------------------------------------------------------
-- Live feed: Realtime Broadcast from the database on a private, per-org topic.
-- Only ids go over the wire; the dashboard re-reads rows through
-- list_device_punches, so the RPC stays the single place that decides access.
-- -----------------------------------------------------------------------------

create or replace function hrms.device_punch_broadcast() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send(
      jsonb_build_object('id', new.id, 'op', tg_op),
      'punch',
      'hrms:device-punches:' || new.org_id::text,
      true
    );
  end if;
  return null;
exception when others then
  return null; -- a realtime hiccup must never fail ingest
end;
$$;
create trigger device_punch_events_broadcast after insert or update on hrms.device_punch_events
  for each row execute function hrms.device_punch_broadcast();

do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists "hrms device punch feed: HR/Admin of the org" on realtime.messages';
    execute $p$
      create policy "hrms device punch feed: HR/Admin of the org"
      on realtime.messages for select to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and (select realtime.topic()) like 'hrms:device-punches:%'
        and public.device_feed_can_listen((select realtime.topic()))
      )
    $p$;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Private photo bucket (no storage.objects policies: service role only)
-- -----------------------------------------------------------------------------

-- [web-hrms] storage bucket removed: files live in Cloudflare R2.
-- -----------------------------------------------------------------------------
-- RLS on (no client policies) + grant sweep
-- -----------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'hrms' loop
    execute format('alter table hrms.%I enable row level security', r.tablename);
  end loop;
end $$;

select hrms.apply_api_grants();
