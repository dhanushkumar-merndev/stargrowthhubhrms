-- [web-hrms] Notification preferences for Web Push (PLAN §7 item 5).
--
-- The in-app inbox always receives every notification. Preferences only
-- decide whether a phone/desktop push is sent:
--   * muted categories (requests, attendance, leave, pay, announcements)
--   * quiet hours in the organisation's time zone (may wrap past midnight)
-- Account and security notices (role changes, password resets, device
-- replacement, setup problems, test pushes) can never be muted.

create table if not exists hrms.notification_prefs (
  employee_id uuid primary key,
  org_id uuid not null,
  muted text[] not null default '{}',
  quiet_start time,
  quiet_end time,
  updated_at timestamptz not null default now(),
  constraint notification_prefs_muted_check
    check (muted <@ array['requests', 'attendance', 'leave', 'pay', 'announcements']::text[]),
  constraint notification_prefs_quiet_check
    check ((quiet_start is null) = (quiet_end is null) and (quiet_start is null or quiet_start <> quiet_end)),
  foreign key (org_id, employee_id) references hrms.employees(org_id, id) on delete cascade
);
alter table hrms.notification_prefs enable row level security;

create or replace function hrms.notification_category(p_kind text) returns text
language sql
immutable
set search_path = ''
as $$
  select case split_part(coalesce(p_kind, ''), '.', 1)
    when 'request' then 'requests'
    when 'attendance' then 'attendance'
    when 'leave' then 'leave'
    when 'payslip' then 'pay'
    when 'salary' then 'pay'
    when 'announcement' then 'announcements'
    else 'account' end;
$$;

-- True when a push for this notification should not be sent now.
create or replace function hrms.push_suppressed(p_recipient uuid, p_kind text, p_at timestamptz default now())
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cat text := hrms.notification_category(p_kind);
  v_p hrms.notification_prefs;
  v_local time;
begin
  if v_cat = 'account' then return false; end if;
  select * into v_p from hrms.notification_prefs where employee_id = p_recipient;
  if not found then return false; end if;
  if v_cat = any(v_p.muted) then return true; end if;
  if v_p.quiet_start is null then return false; end if;
  select (p_at at time zone o.timezone)::time into v_local
  from hrms.employees e join hrms.organizations o on o.id = e.org_id where e.id = p_recipient;
  if v_local is null then return false; end if;
  if v_p.quiet_start < v_p.quiet_end then
    return v_local >= v_p.quiet_start and v_local < v_p.quiet_end;
  end if;
  return v_local >= v_p.quiet_start or v_local < v_p.quiet_end; -- wraps past midnight
end;
$$;

create or replace function public.get_notification_prefs() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_p hrms.notification_prefs;
begin
  select * into v_p from hrms.notification_prefs where employee_id = v_actor.employee_id;
  return hrms.ok(jsonb_build_object(
    'muted', to_jsonb(coalesce(v_p.muted, '{}'::text[])),
    'quiet_start', to_char(v_p.quiet_start, 'HH24:MI'),
    'quiet_end', to_char(v_p.quiet_end, 'HH24:MI'),
    'timezone', v_actor.timezone,
    'categories', jsonb_build_array('requests', 'attendance', 'leave', 'pay', 'announcements'),
    'devices', (select count(*) from hrms.push_tokens t where t.employee_id = v_actor.employee_id and t.revoked_at is null)));
end;
$$;

create or replace function public.set_notification_prefs(p_muted text[], p_quiet_start time, p_quiet_end time)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_muted text[] := array(select distinct m from unnest(coalesce(p_muted, '{}')) m order by m);
begin
  if not (v_muted <@ array['requests', 'attendance', 'leave', 'pay', 'announcements']::text[]) then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown notification category.', jsonb_build_object('muted', 'Unknown category'));
  end if;
  if (p_quiet_start is null) <> (p_quiet_end is null) then
    perform hrms.raise_error('VALIDATION_FAILED', 'Give both quiet-hour times or neither.', jsonb_build_object('quiet_end', 'Give both times or neither'));
  end if;
  if p_quiet_start is not null and p_quiet_start = p_quiet_end then
    perform hrms.raise_error('VALIDATION_FAILED', 'Quiet hours must start and end at different times.', jsonb_build_object('quiet_end', 'Must differ from the start'));
  end if;
  insert into hrms.notification_prefs (employee_id, org_id, muted, quiet_start, quiet_end)
  values (v_actor.employee_id, v_actor.org_id, v_muted, p_quiet_start, p_quiet_end)
  on conflict (employee_id) do update
    set muted = excluded.muted, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, updated_at = now();
  return public.get_notification_prefs();
end;
$$;

-- A one-off push to the caller's own devices, to check setup.
create or replace function public.send_test_notification() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_recent integer;
begin
  select count(*) into v_recent from hrms.notifications
   where recipient_id = v_actor.employee_id and kind = 'account.test' and created_at > now() - interval '1 minute';
  if v_recent >= 3 then
    perform hrms.raise_error('RATE_LIMITED', 'Wait a minute before sending another test.');
  end if;
  perform hrms.notify(v_actor.org_id, v_actor.employee_id, 'account.test', 'Notifications are working',
    'You will get alerts like this one on this device.', '/notifications');
  return hrms.ok(jsonb_build_object('sent', true));
end;
$$;

-- Same claim as before plus `suppressed` (preferences) per job; the worker
-- completes suppressed jobs as 'skipped' without contacting a push service.
create or replace function public.internal_claim_outbox(p_limit integer default 50, p_lease_seconds integer default 60)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs jsonb;
begin
  with due as (
    select o.id from hrms.outbox o
    where o.status in ('pending', 'sending') and o.next_attempt_at <= now()
      and (o.lease_until is null or o.lease_until < now())
    order by o.next_attempt_at, o.id
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
    for update skip locked
  ),
  claimed as (
    update hrms.outbox o set status = 'sending', attempts = o.attempts + 1,
           lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 60), 10), 300))
    from due where o.id = due.id
    returning o.id, o.notification_id, o.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'outbox_id', c.id, 'attempts', c.attempts,
      'event_id', n.event_id, 'kind', n.kind, 'title', n.title, 'body', n.body, 'deep_link', n.deep_link,
      'notification_id', n.id,
      'suppressed', hrms.push_suppressed(n.recipient_id, n.kind, now()),
      'tokens', (select coalesce(jsonb_agg(jsonb_build_object('token', t.token, 'platform', t.platform)), '[]'::jsonb)
                 from hrms.push_tokens t where t.employee_id = n.recipient_id and t.revoked_at is null))), '[]'::jsonb)
    into v_jobs
  from claimed c join hrms.notifications n on n.id = c.notification_id;
  return v_jobs;
end;
$$;
revoke all on function public.internal_claim_outbox(integer, integer) from public, anon, authenticated;
grant execute on function public.internal_claim_outbox(integer, integer) to service_role;

select hrms.apply_api_grants();
