-- web-hrms: one call for the home dashboard.
--
--   me      today's punch, this month (days, hours), the last 7 days of
--           worked hours, open / overdue tasks, today's work report, open
--           requests and fix requests.
--   team    team leaders: their team (people they can see) today (in, not in, outdoor, on leave,
--           work reports written).
--   org     HR/Admin: everyone today, what waits for them, and the share of
--           people who punched in on each of the last 7 days.
--
-- Read-only and scoped exactly like the screens it links to.

create or replace function hrms.day_people(p_org uuid, p_people uuid[], p_day date) returns jsonb
language sql stable security definer set search_path = '' as $$
  with p as (select unnest(p_people) as id)
  select jsonb_build_object(
    'total', (select count(*) from p),
    'punched_in', (select count(*) from hrms.device_attendance_days d
                   where d.org_id = p_org and d.local_date = p_day and d.employee_id in (select id from p)
                     and d.first_in_at is not null),
    'in_now', (select count(*) from hrms.device_attendance_days d
               where d.org_id = p_org and d.local_date = p_day and d.employee_id in (select id from p)
                 and d.first_in_at is not null and d.out_source is null),
    'outdoor', (select count(*) from hrms.outside_work w
                where w.org_id = p_org and w.work_date = p_day and w.kind = 'outdoor' and w.revoked_at is null
                  and w.employee_id in (select id from p)),
    'on_leave', (select count(distinct s.employee_id) from hrms.leave_day_slots s
                 where s.org_id = p_org and s.day = p_day and s.state = 'approved'
                   and s.employee_id in (select id from p)),
    'reports', (select count(distinct w.employee_id) from hrms.work_logs w
                where w.org_id = p_org and w.work_date = p_day and w.employee_id in (select id from p))
  );
$$;

create or replace function public.get_dashboard() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_today date := hrms.org_today(v_actor.org_id);
  v_month date := date_trunc('month', v_today)::date;
  v_me uuid := v_actor.employee_id;
  v_d hrms.device_attendance_days;
  v_team uuid[];
  v_all uuid[];
  v_team_json jsonb;
  v_org_json jsonb;
begin
  select * into v_d from hrms.device_attendance_days
  where org_id = v_actor.org_id and employee_id = v_me and local_date = v_today;

  -- Team leaders: the members of the teams they lead today.
  if cardinality(hrms.leads_teams(v_me, v_today)) > 0 then
    select coalesce(array_agg(e.id), array[]::uuid[]) into v_team
    from hrms.employees e
    where e.org_id = v_actor.org_id and e.status = 'active' and e.id <> v_me
      and hrms.team_on(e.id, v_today) = any(hrms.leads_teams(v_me, v_today))
      and hrms.can_see_work(v_actor, e.id);
    v_team_json := hrms.day_people(v_actor.org_id, v_team, v_today)
      || jsonb_build_object('open_tasks', (select count(*) from hrms.tasks t
                                           where t.assigned_to = any(v_team) and t.status in ('todo', 'in_progress')),
                            'overdue_tasks', (select count(*) from hrms.tasks t
                                              where t.assigned_to = any(v_team) and t.status in ('todo', 'in_progress')
                                                and t.due_date < v_today));
  end if;

  if hrms.is_hr_or_admin(v_actor) then
    select coalesce(array_agg(e.id), array[]::uuid[]) into v_all
    from hrms.employees e where e.org_id = v_actor.org_id and e.status = 'active';
    v_org_json := hrms.day_people(v_actor.org_id, v_all, v_today) || jsonb_build_object(
      'waiting', jsonb_build_object(
        'requests', (select count(*) from hrms.requests r
                     where r.org_id = v_actor.org_id and r.state in ('submitted', 'under_review') and r.employee_id <> v_me),
        'punch_fixes', (select count(*) from hrms.punch_fix_requests f
                        where f.org_id = v_actor.org_id and f.status = 'pending' and f.employee_id <> v_me),
        'outdoor_today', (select count(*) from hrms.outside_work w
                          where w.org_id = v_actor.org_id and w.work_date = v_today and w.kind = 'outdoor' and w.revoked_at is null),
        'machine_people', (select count(*) from hrms.device_users u
                           where u.org_id = v_actor.org_id
                             and not exists (select 1 from hrms.device_user_links l
                                             where l.org_id = u.org_id and l.pin = u.pin and l.unlinked_at is null
                                               and (l.serial is null or l.serial = u.serial)))),
      'week', (select jsonb_agg(jsonb_build_object(
                  'date', to_char(g.day, 'YYYY-MM-DD'),
                  'punched_in', (select count(*) from hrms.device_attendance_days d
                                 where d.org_id = v_actor.org_id and d.local_date = g.day and d.first_in_at is not null
                                   and d.employee_id = any(v_all)),
                  'outdoor', (select count(*) from hrms.outside_work w
                              where w.org_id = v_actor.org_id and w.work_date = g.day and w.kind = 'outdoor'
                                and w.revoked_at is null and w.employee_id = any(v_all)),
                  'on_leave', (select count(distinct s.employee_id) from hrms.leave_day_slots s
                               where s.org_id = v_actor.org_id and s.day = g.day and s.state = 'approved'
                                 and s.employee_id = any(v_all))) order by g.day)
               from generate_series(v_today - 6, v_today, interval '1 day') as gs(ts), lateral (select gs.ts::date as day) g)
    );
  end if;

  return hrms.ok(jsonb_build_object(
    'date', to_char(v_today, 'YYYY-MM-DD'),
    'has_machines', hrms.org_has_machines(v_actor.org_id),
    'me', jsonb_build_object(
      'today', jsonb_build_object(
        'first_in_at', v_d.first_in_at, 'out_at', case when v_d.out_source <> 'auto' then v_d.out_at end,
        'out_source', v_d.out_source, 'worked_minutes', v_d.worked_minutes,
        'outdoor', (select case when w.revoked_at is null then 'counted' else 'rejected' end
                    from hrms.outside_work w where w.employee_id = v_me and w.work_date = v_today and w.kind = 'outdoor'
                    order by w.revoked_at is null desc, w.created_at desc limit 1)),
      'month', (select jsonb_build_object(
                  'days', count(*) filter (where d.first_in_at is not null),
                  'worked_minutes', coalesce(sum(d.worked_minutes), 0),
                  'missed_out', count(*) filter (where d.out_source = 'auto' or (d.out_source is null and d.local_date < v_today)))
                from hrms.device_attendance_days d
                where d.org_id = v_actor.org_id and d.employee_id = v_me and d.local_date between v_month and v_today),
      'outdoor_days', (select count(*) from hrms.outside_work w where w.employee_id = v_me
                       and w.work_date between v_month and v_today and w.kind = 'outdoor' and w.revoked_at is null),
      'week', (select jsonb_agg(jsonb_build_object(
                  'date', to_char(g.day, 'YYYY-MM-DD'),
                  'worked_minutes', (select d.worked_minutes from hrms.device_attendance_days d
                                     where d.org_id = v_actor.org_id and d.employee_id = v_me and d.local_date = g.day),
                  'in', exists (select 1 from hrms.device_attendance_days d
                                where d.org_id = v_actor.org_id and d.employee_id = v_me and d.local_date = g.day
                                  and d.first_in_at is not null)) order by g.day)
               from generate_series(v_today - 6, v_today, interval '1 day') as gs(ts), lateral (select gs.ts::date as day) g),
      'tasks', (select jsonb_build_object(
                  'open', count(*),
                  'overdue', count(*) filter (where t.due_date < v_today),
                  'due_today', count(*) filter (where t.due_date = v_today))
                from hrms.tasks t where t.assigned_to = v_me and t.status in ('todo', 'in_progress')),
      'report_minutes_today', (select coalesce(sum(w.minutes), 0) from hrms.work_logs w where w.employee_id = v_me and w.work_date = v_today),
      'report_entries_today', (select count(*) from hrms.work_logs w where w.employee_id = v_me and w.work_date = v_today),
      'open_requests', (select count(*) from hrms.requests r
                        where r.employee_id = v_me and r.state in ('draft', 'submitted', 'under_review', 'returned')),
      'pending_fixes', (select count(*) from hrms.punch_fix_requests f where f.employee_id = v_me and f.status = 'pending')
    ),
    'team', v_team_json,
    'org', v_org_json
  ));
end;
$$;

select hrms.apply_api_grants();
