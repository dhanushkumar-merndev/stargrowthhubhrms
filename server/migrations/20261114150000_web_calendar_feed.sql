-- [web-hrms] Personal calendar feed (PLAN §7 item 7).
--
-- Each person may have one secret feed URL that Google Calendar, Outlook or
-- Apple Calendar subscribe to. It lists the published holidays that apply to
-- them and their own approved leave. Nothing else (no reasons, no other
-- people). Only a SHA-256 of the token is stored; creating a new link
-- replaces the old one, and turning it off revokes it at once. Feeds stop
-- working when the person is deactivated.

create table if not exists hrms.calendar_feeds (
  employee_id uuid primary key,
  org_id uuid not null,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  foreign key (org_id, employee_id) references hrms.employees(org_id, id) on delete cascade
);
alter table hrms.calendar_feeds enable row level security;

create or replace function public.get_calendar_feed() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_f hrms.calendar_feeds;
begin
  select * into v_f from hrms.calendar_feeds where employee_id = v_actor.employee_id;
  return hrms.ok(jsonb_build_object('enabled', found, 'created_at', v_f.created_at, 'last_used_at', v_f.last_used_at));
end;
$$;

-- Returns the raw token once; the app builds the URL from it.
create or replace function public.create_calendar_feed() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_token text := hrms.random_token(32);
begin
  insert into hrms.calendar_feeds (employee_id, org_id, token_hash)
  values (v_actor.employee_id, v_actor.org_id, extensions.digest(v_token, 'sha256'))
  on conflict (employee_id) do update
    set token_hash = excluded.token_hash, created_at = now(), last_used_at = null;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'calendar_feed.created', 'employee', v_actor.employee_id, null, 'business', v_actor.employee_id);
  return hrms.ok(jsonb_build_object('token', v_token, 'enabled', true, 'created_at', now(), 'last_used_at', null));
end;
$$;

create or replace function public.revoke_calendar_feed() returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
begin
  delete from hrms.calendar_feeds where employee_id = v_actor.employee_id;
  if found then
    perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'calendar_feed.revoked', 'employee', v_actor.employee_id, null, 'business', v_actor.employee_id);
  end if;
  return hrms.ok(jsonb_build_object('enabled', false, 'created_at', null, 'last_used_at', null));
end;
$$;

-- Server only: the feed contents for a token hash, or null when the link is
-- unknown, revoked, or its owner is no longer active.
create or replace function public.internal_calendar_feed(p_token_sha256 text) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash bytea;
  v_f hrms.calendar_feeds;
  v_e hrms.employees;
  v_org hrms.organizations;
  v_today date;
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then return null; end if;
  v_hash := decode(p_token_sha256, 'hex');
  select * into v_f from hrms.calendar_feeds where token_hash = v_hash;
  if not found then return null; end if;
  select * into v_e from hrms.employees where id = v_f.employee_id;
  if v_e.status <> 'active' then return null; end if;
  select * into v_org from hrms.organizations where id = v_f.org_id;
  v_today := (now() at time zone v_org.timezone)::date;
  -- Calendar apps poll often; record use at most once an hour.
  if v_f.last_used_at is null or v_f.last_used_at < now() - interval '1 hour' then
    update hrms.calendar_feeds set last_used_at = now() where employee_id = v_f.employee_id;
  end if;
  return jsonb_build_object(
    'org_name', v_org.name,
    'timezone', v_org.timezone,
    'holidays', (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'date', h.holiday_date, 'name', h.name)
                                           order by h.holiday_date, h.id), '[]'::jsonb)
                 from hrms.holidays h
                 where h.org_id = v_org.id and h.state = 'published'
                   and h.holiday_date between v_today - 366 and v_today + 400
                   and (h.office_id is null or h.office_id = (
                         select a.office_id from hrms.office_assignments a
                         where a.employee_id = v_e.id
                           and daterange(a.effective_from, a.effective_to, '[)') @> h.holiday_date
                         limit 1))),
    'leave', (select coalesce(jsonb_agg(jsonb_build_object('request_id', x.request_id, 'date', x.day,
                                                           'slots', x.slots, 'type', x.type_name)
                                        order by x.day, x.request_id), '[]'::jsonb)
              from (select s.request_id, s.day, array_agg(s.slot order by s.slot) as slots,
                           min(t.name) as type_name
                    from hrms.leave_day_slots s
                    join hrms.requests r on r.id = s.request_id
                    left join hrms.leave_types t on t.id = r.leave_type_id
                    where s.employee_id = v_e.id and s.state = 'approved'
                      and s.day between v_today - 366 and v_today + 400
                    group by s.request_id, s.day) x));
end;
$$;
revoke all on function public.internal_calendar_feed(text) from public, anon, authenticated;
grant execute on function public.internal_calendar_feed(text) to service_role;

select hrms.apply_api_grants();
