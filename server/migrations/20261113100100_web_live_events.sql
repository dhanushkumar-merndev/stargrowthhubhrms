-- [web-hrms] Live updates without Supabase Realtime.
--
-- Producers call hrms.publish_live(...). It appends a row and sends
-- pg_notify('hrms_live', '<id>') which is delivered only on COMMIT (a rolled
-- back change never produces an event). The Rust SSE hub LISTENs, reads rows
-- with id > last seen, and forwards each one only to connections whose actor
-- matches the audience. Browsers resume with Last-Event-ID = row id.
--
-- Payloads carry ids only: the client re-reads through the normal RPCs, which
-- remain the single place that decides access.

create table if not exists hrms.live_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references hrms.organizations(id) on delete cascade,
  -- hr_admin: active HR/Admin of the org; employee: one person; org: everyone in the org
  audience text not null check (audience in ('hr_admin', 'employee', 'org')),
  employee_id uuid,
  kind text not null check (kind ~ '^[a-z][a-z_.]{1,40}$'),
  payload jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 1024),
  created_at timestamptz not null default now(),
  check ((audience = 'employee') = (employee_id is not null))
);
create index if not exists live_events_created_idx on hrms.live_events (created_at);

alter table hrms.live_events enable row level security;
revoke all on hrms.live_events from public, anon, authenticated;
grant select, delete on hrms.live_events to service_role;

create or replace function hrms.publish_live(
  p_org uuid, p_audience text, p_employee uuid, p_kind text, p_payload jsonb
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_id bigint;
begin
  insert into hrms.live_events (org_id, audience, employee_id, kind, payload)
  values (p_org, p_audience, p_employee, p_kind, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  perform pg_notify('hrms_live', v_id::text);
end;
$$;
revoke all on function hrms.publish_live(uuid, text, uuid, text, jsonb) from public;

-- Old events are only useful for reconnects within a short window.
create or replace function public.internal_purge_live_events(p_older_than interval default interval '2 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_n integer;
begin
  delete from hrms.live_events where created_at < now() - p_older_than;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.internal_purge_live_events(interval) from public, anon, authenticated;
grant execute on function public.internal_purge_live_events(interval) to service_role;

-- ---------------------------------------------------------------- device feed
create or replace function hrms.device_punch_broadcast() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform hrms.publish_live(new.org_id, 'hr_admin', null, 'device.punch',
    jsonb_build_object('id', new.id, 'op', lower(tg_op)));
  return null;
exception when others then
  return null; -- a live-update hiccup must never fail ingest
end;
$$;

create or replace function hrms.device_command_broadcast() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform hrms.publish_live(new.org_id, 'hr_admin', null, 'device.command',
    jsonb_build_object('id', new.id, 'status', new.status, 'op', lower(tg_op)));
  return null;
exception when others then
  return null;
end;
$$;

-- --------------------------------------------------------------- notifications
-- A new in-app notification wakes that person's open tabs (badge + list).
create or replace function hrms.notification_live() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform hrms.publish_live(new.org_id, 'employee', new.recipient_id, 'notification.new',
    jsonb_build_object('id', new.id));
  return null;
exception when others then
  return null;
end;
$$;
drop trigger if exists notifications_live on hrms.notifications;
create trigger notifications_live after insert on hrms.notifications
  for each row execute function hrms.notification_live();
