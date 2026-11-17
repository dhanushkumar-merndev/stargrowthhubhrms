-- Keep machine clocks right without anyone touching the machine.
--
-- Each punch already records how far the machine clock is from ours
-- (attendance_devices.clock_drift_seconds). When that is more than a minute
-- out, the next poll queues a 'set_time' command, rendered as
--   SET OPTION DateTime=<packed>
-- where <packed> is ZKTeco's own time encoding: seconds in a calendar of
-- twelve 31-day months from 2000-01-01, in the organisation's local time.
-- The value is computed when the machine collects the command, so it is
-- never stale. A successful set clears the drift; the next punch measures it
-- again, and a machine that drifts again is corrected again. At most one
-- attempt per 10 minutes, and none for 6 hours after the machine rejects one.

alter table hrms.device_commands drop constraint device_commands_kind_check;
alter table hrms.device_commands add constraint device_commands_kind_check
  check (kind in ('user_upsert', 'user_delete', 'enroll_fingerprint', 'enroll_face', 'user_query', 'set_time'));
alter table hrms.device_commands drop constraint device_commands_reason_check;
alter table hrms.device_commands add constraint device_commands_reason_check
  check (reason in ('assign_pin', 'sync', 'employee_changed', 'enroll', 'remove', 'fetch_users', 'clock_sync'));
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
    when 'user_query' then payload = '{}'::jsonb and pin = '0'
    when 'set_time' then payload = '{}'::jsonb and pin = '0'
    else false end);

-- ZKTeco packed time for a local wall-clock timestamp.
create or replace function hrms.zk_packed_time(p_local timestamp) returns bigint
language sql
immutable
set search_path = ''
as $$
  select (((extract(year from p_local)::bigint % 100) * 12 * 31
           + (extract(month from p_local)::bigint - 1) * 31
           + extract(day from p_local)::bigint - 1) * 86400)
         + extract(hour from p_local)::bigint * 3600
         + extract(minute from p_local)::bigint * 60
         + floor(extract(second from p_local))::bigint;
$$;

-- Now stable (not immutable): set_time reads the clock and the org time zone.
create or replace function hrms.device_command_line(c hrms.device_commands) returns text
language sql
stable
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
    when 'user_query' then
      'DATA QUERY USERINFO'
    when 'set_time' then
      'SET OPTION DateTime=' || hrms.zk_packed_time(
        now() at time zone coalesce((select o.timezone from hrms.organizations o where o.id = c.org_id), 'Asia/Kolkata'))::text
  end;
$$;

-- Queue a clock fix when the machine is more than a minute out. Returns the
-- command id, or null when nothing was queued.
create or replace function hrms.device_clock_check(p_dev hrms.attendance_devices) returns bigint
language plpgsql
set search_path = ''
as $$
begin
  if not p_dev.commands_enabled or not p_dev.active
     or p_dev.clock_drift_seconds is null or abs(p_dev.clock_drift_seconds) <= 60 then
    return null;
  end if;
  -- A set the machine never answered is given up after 5 minutes.
  update hrms.device_commands set status = 'failed', completed_at = now()
  where serial = p_dev.serial and kind = 'set_time' and status = 'sent' and sent_at < now() - interval '5 minutes';
  if exists (select 1 from hrms.device_commands
             where serial = p_dev.serial and kind = 'set_time'
               and (status in ('queued', 'sent')
                    or created_at > now() - interval '10 minutes'
                    or (status = 'failed' and return_code is not null and completed_at > now() - interval '6 hours'))) then
    return null;
  end if;
  return hrms.device_queue(p_dev.org_id, p_dev.serial, 'set_time', '0', null, '{}'::jsonb, 'clock_sync', null);
end;
$$;

-- A successful set means the old drift no longer applies.
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
  elsif c.kind = 'set_time' then
    update hrms.attendance_devices set clock_drift_seconds = null where serial = c.serial;
  end if;
end;
$$;

-- Same as before, plus the clock check before commands are handed out.
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

  perform hrms.device_clock_check(v_dev);

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

revoke all on function hrms.zk_packed_time(timestamp) from public, anon, authenticated;
revoke all on function hrms.device_clock_check(hrms.attendance_devices) from public, anon, authenticated;
