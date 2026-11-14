-- [web-hrms] Birthdays and work anniversaries on Home (PLAN §7 item 9).
--
-- Privacy: a birthday is shown only when its owner turns it on, and only the
-- day and month ever leave the database (never the year of birth). Work
-- anniversaries come from the join date and are shown unless the person
-- hides them. Only active colleagues in the same organisation are listed.

create table if not exists hrms.celebration_prefs (
  employee_id uuid primary key,
  org_id uuid not null,
  share_birthday boolean not null default false,
  share_anniversary boolean not null default true,
  updated_at timestamptz not null default now(),
  foreign key (org_id, employee_id) references hrms.employees(org_id, id) on delete cascade
);
alter table hrms.celebration_prefs enable row level security;

-- Next yearly occurrence of p_date on or after p_from. 29 February falls on
-- 28 February in other years.
create or replace function hrms.next_yearly(p_date date, p_from date) returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_year integer := extract(year from p_from)::integer;
  v_m integer := extract(month from p_date)::integer;
  v_d integer := extract(day from p_date)::integer;
  v_try date;
begin
  if p_date is null or p_from is null then return null; end if;
  for i in 0..1 loop
    v_try := make_date(v_year + i, v_m, 1);
    v_try := v_try + (least(v_d, extract(day from (v_try + interval '1 month' - interval '1 day'))::integer) - 1);
    if v_try >= p_from then return v_try; end if;
  end loop;
  return null;
end;
$$;

create or replace function public.get_celebration_prefs() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_p hrms.celebration_prefs;
begin
  select * into v_p from hrms.celebration_prefs where employee_id = v_actor.employee_id;
  return hrms.ok(jsonb_build_object(
    'share_birthday', coalesce(v_p.share_birthday, false),
    'share_anniversary', coalesce(v_p.share_anniversary, true),
    'has_birthday', exists (select 1 from hrms.employee_private_details d
                            where d.employee_id = v_actor.employee_id and d.date_of_birth is not null)));
end;
$$;

create or replace function public.set_celebration_prefs(p_share_birthday boolean, p_share_anniversary boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
begin
  if p_share_birthday is null or p_share_anniversary is null then
    perform hrms.raise_error('VALIDATION_FAILED', 'Choose on or off for both.');
  end if;
  insert into hrms.celebration_prefs (employee_id, org_id, share_birthday, share_anniversary)
  values (v_actor.employee_id, v_actor.org_id, p_share_birthday, p_share_anniversary)
  on conflict (employee_id) do update
    set share_birthday = excluded.share_birthday, share_anniversary = excluded.share_anniversary, updated_at = now();
  return public.get_celebration_prefs();
end;
$$;

-- Today and the next p_days days (0–31), soonest first.
create or replace function public.list_celebrations(p_days integer default 7) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_today date := hrms.org_today(v_actor.org_id);
  v_days integer := least(greatest(coalesce(p_days, 7), 0), 31);
begin
  return hrms.ok(jsonb_build_object('today', v_today, 'rows', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'employee_id', x.id, 'name', x.full_name, 'kind', x.kind, 'date', x.on_date,
             'years', x.years, 'is_today', x.on_date = v_today, 'is_me', x.id = v_actor.employee_id)
           order by x.on_date, x.kind, x.full_name, x.id), '[]'::jsonb)
    from (
      select e.id, e.full_name, 'birthday' as kind, hrms.next_yearly(d.date_of_birth, v_today) as on_date, null::integer as years
      from hrms.employees e
      join hrms.employee_private_details d on d.employee_id = e.id
      join hrms.celebration_prefs p on p.employee_id = e.id and p.share_birthday
      where e.org_id = v_actor.org_id and e.status = 'active' and d.date_of_birth is not null
      union all
      select e.id, e.full_name, 'anniversary', a.on_date,
             (extract(year from a.on_date) - extract(year from e.join_date))::integer
      from hrms.employees e
      left join hrms.celebration_prefs p on p.employee_id = e.id
      cross join lateral (select hrms.next_yearly(e.join_date, v_today) as on_date) a
      where e.org_id = v_actor.org_id and e.status = 'active' and coalesce(p.share_anniversary, true)
        and e.join_date < v_today
        and (extract(year from a.on_date) - extract(year from e.join_date)) >= 1
    ) x
    where x.on_date between v_today and v_today + v_days)));
end;
$$;

select hrms.apply_api_grants();
