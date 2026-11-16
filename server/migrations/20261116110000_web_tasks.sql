-- [web-hrms] Tasks and daily work reports (owner request, 2026-11-16).
--
-- Tasks: HR, Admins and team leaders give work to people, with a due date
-- and priority. The person updates the status; the giver is told when it is
-- done.
--   Admin        -> anyone in the organisation
--   HR           -> employees and team leaders (not other HR or Admins)
--   Team leader  -> current members of the team(s) they lead
--   Anyone       -> themselves (a personal to-do)
--
-- Daily work report: what someone did on a day, with details and time spent,
-- optionally against a task. Who can read it:
--   an employee's    -> themselves, their current team leader, HR, Admins
--   a team leader's  -> themselves, HR, Admins
--   an HR person's   -> themselves, Admins
--   an Admin's       -> themselves, Admins
-- "Team leader" = current manager of a team (hrms.team_managers).
-- Reports can be written for today and the 7 days before, and edited or
-- removed by their author in that window.

-- ------------------------------------------------------------------ helpers

create or replace function hrms.leads_teams(p_employee uuid, p_date date) returns uuid[]
language sql stable set search_path = '' as $$
  select coalesce(array_agg(tm.team_id), array[]::uuid[]) from hrms.team_managers tm
  where tm.manager_id = p_employee and tm.effective_from <= p_date
    and (tm.effective_to is null or tm.effective_to > p_date);
$$;

-- 3 Admin, 2 HR, 1 team leader, 0 employee.
create or replace function hrms.work_tier(p_employee uuid, p_date date) returns integer
language sql stable set search_path = '' as $$
  select case
    when 'admin' = any(hrms.employee_roles(p_employee)) then 3
    when 'hr' = any(hrms.employee_roles(p_employee)) then 2
    when cardinality(hrms.leads_teams(p_employee, p_date)) > 0 then 1
    else 0 end;
$$;

-- True when p_lead currently leads the team p_member currently belongs to.
create or replace function hrms.is_lead_of(p_lead uuid, p_member uuid, p_date date) returns boolean
language sql stable set search_path = '' as $$
  select p_lead <> p_member and hrms.team_on(p_member, p_date) = any(hrms.leads_teams(p_lead, p_date));
$$;

create or replace function hrms.can_see_work(p_actor hrms.actor, p_target uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date;
  v_tier integer;
begin
  if p_target is null then return false; end if;
  if p_target = p_actor.employee_id then return true; end if;
  if not exists (select 1 from hrms.employees where id = p_target and org_id = p_actor.org_id) then
    return false;
  end if;
  if 'admin' = any(p_actor.roles) then return true; end if;
  v_today := hrms.org_today(p_actor.org_id);
  v_tier := hrms.work_tier(p_target, v_today);
  if v_tier >= 2 then return false; end if;
  if 'hr' = any(p_actor.roles) then return true; end if;
  return v_tier = 0 and hrms.is_lead_of(p_actor.employee_id, p_target, v_today);
end;
$$;

create or replace function hrms.can_assign_task(p_actor hrms.actor, p_target uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := hrms.org_today(p_actor.org_id);
begin
  if not exists (select 1 from hrms.employees where id = p_target and org_id = p_actor.org_id and status = 'active') then
    return false;
  end if;
  if p_target = p_actor.employee_id or 'admin' = any(p_actor.roles) then return true; end if;
  if 'hr' = any(p_actor.roles) then return hrms.work_tier(p_target, v_today) < 2; end if;
  return hrms.work_tier(p_target, v_today) = 0 and hrms.is_lead_of(p_actor.employee_id, p_target, v_today);
end;
$$;

-- Tasks go into the "requests" notification category.
create or replace function hrms.notification_category(p_kind text) returns text
language sql
immutable
set search_path = ''
as $$
  select case split_part(coalesce(p_kind, ''), '.', 1)
    when 'request' then 'requests'
    when 'task' then 'requests'
    when 'attendance' then 'attendance'
    when 'leave' then 'leave'
    when 'payslip' then 'pay'
    when 'salary' then 'pay'
    when 'announcement' then 'announcements'
    else 'account' end;
$$;

-- ------------------------------------------------------------------- tables

create table if not exists hrms.tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  assigned_to uuid not null,
  assigned_by uuid not null,
  title text not null check (char_length(title) between 2 and 200),
  description text check (description is null or char_length(description) <= 4000),
  due_date date,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (org_id, id),
  foreign key (org_id, assigned_to) references hrms.employees(org_id, id) on delete cascade,
  foreign key (org_id, assigned_by) references hrms.employees(org_id, id) on delete cascade
);
create index if not exists tasks_assignee_idx on hrms.tasks (assigned_to, status, due_date);
create index if not exists tasks_giver_idx on hrms.tasks (assigned_by, created_at desc);
alter table hrms.tasks enable row level security;

create table if not exists hrms.work_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  employee_id uuid not null,
  work_date date not null,
  title text not null check (char_length(title) between 2 and 200),
  details text not null check (char_length(details) between 2 and 4000),
  minutes integer check (minutes is null or minutes between 1 and 1440),
  task_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  foreign key (org_id, employee_id) references hrms.employees(org_id, id) on delete cascade,
  foreign key (org_id, task_id) references hrms.tasks(org_id, id) on delete set null (task_id)
);
create index if not exists work_logs_emp_idx on hrms.work_logs (employee_id, work_date desc);
create index if not exists work_logs_org_day_idx on hrms.work_logs (org_id, work_date);
alter table hrms.work_logs enable row level security;

-- ------------------------------------------------------------------ JSON

create or replace function hrms.person_json(p_employee uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name)
  from hrms.employees e where e.id = p_employee;
$$;

create or replace function hrms.task_json(t hrms.tasks, p_actor hrms.actor) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', t.id, 'title', t.title, 'description', t.description, 'due_date', t.due_date,
    'priority', t.priority, 'status', t.status, 'completed_at', t.completed_at,
    'created_at', t.created_at, 'updated_at', t.updated_at, 'version', t.version,
    'assigned_to', hrms.person_json(t.assigned_to), 'assigned_by', hrms.person_json(t.assigned_by),
    'is_mine', t.assigned_to = p_actor.employee_id,
    'can_manage', t.assigned_by = p_actor.employee_id or 'admin' = any(p_actor.roles)
                  or (t.assigned_to <> p_actor.employee_id and hrms.can_assign_task(p_actor, t.assigned_to)),
    'overdue', t.status in ('todo', 'in_progress') and t.due_date < hrms.org_today(t.org_id),
    'logged_minutes', (select coalesce(sum(w.minutes), 0) from hrms.work_logs w where w.task_id = t.id));
$$;

create or replace function hrms.work_log_json(w hrms.work_logs, p_actor hrms.actor) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', w.id, 'work_date', w.work_date, 'title', w.title, 'details', w.details, 'minutes', w.minutes,
    'task', case when w.task_id is null then null else
      (select jsonb_build_object('id', t.id, 'title', t.title) from hrms.tasks t where t.id = w.task_id) end,
    'created_at', w.created_at, 'updated_at', w.updated_at, 'version', w.version,
    'can_edit', w.employee_id = p_actor.employee_id and w.work_date >= hrms.org_today(w.org_id) - 7);
$$;

-- ------------------------------------------------------------------- tasks

create or replace function public.create_task(
  p_assigned_to uuid, p_title text, p_description text default null,
  p_due_date date default null, p_priority text default 'normal'
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_title text := hrms.clean_text(p_title, 200);
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_today date := hrms.org_today(v_actor.org_id);
  v_errors jsonb := '{}'::jsonb;
  v_t hrms.tasks;
begin
  if p_assigned_to is null or not hrms.can_assign_task(v_actor, p_assigned_to) then
    perform hrms.raise_error('ACCESS_DENIED', 'You cannot give tasks to this person.');
  end if;
  if v_title is null or char_length(v_title) < 2 then v_errors := v_errors || '{"title":"Give the task a title"}'; end if;
  if v_desc is not null and char_length(v_desc) > 4000 then v_errors := v_errors || '{"description":"Keep it under 4000 characters"}'; end if;
  if coalesce(p_priority, 'normal') not in ('low', 'normal', 'high') then v_errors := v_errors || '{"priority":"Choose low, normal or high"}'; end if;
  if p_due_date is not null and (p_due_date < v_today or p_due_date > v_today + 366) then
    v_errors := v_errors || '{"due_date":"Pick a date from today up to a year ahead"}';
  end if;
  if v_errors <> '{}'::jsonb then
    perform hrms.raise_error('VALIDATION_FAILED', 'Please check the highlighted fields.', v_errors);
  end if;
  if (select count(*) from hrms.tasks where assigned_to = p_assigned_to and status in ('todo', 'in_progress')) >= 200 then
    perform hrms.raise_error('VALIDATION_FAILED', 'This person already has 200 open tasks.');
  end if;
  insert into hrms.tasks (org_id, assigned_to, assigned_by, title, description, due_date, priority)
  values (v_actor.org_id, p_assigned_to, v_actor.employee_id, v_title, v_desc, p_due_date, coalesce(p_priority, 'normal'))
  returning * into v_t;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'task.create', 'task', v_t.id,
    jsonb_build_object('assigned_to', p_assigned_to, 'title', v_title, 'due_date', p_due_date, 'priority', v_t.priority),
    'business', p_assigned_to);
  if p_assigned_to <> v_actor.employee_id then
    perform hrms.notify(v_actor.org_id, p_assigned_to, 'task.assigned', 'New task: ' || left(v_title, 80),
      coalesce('Due ' || to_char(p_due_date, 'DD Mon') || '. ', '') || 'From '
        || (select full_name from hrms.employees where id = v_actor.employee_id) || '.',
      '/tasks/' || v_t.id::text);
  end if;
  return hrms.ok(hrms.task_json(v_t, v_actor));
end;
$$;

-- p_patch: {title, description, due_date, priority} (giver/manager) and/or
-- {status} (assignee: todo/in_progress/done; giver/manager: also cancelled).
create or replace function public.update_task(p_task_id uuid, p_patch jsonb, p_expected_version integer)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_t hrms.tasks;
  v_old hrms.tasks;
  v_manage boolean;
  v_mine boolean;
  v_status text := nullif(p_patch ->> 'status', '');
  v_title text;
  v_today date := hrms.org_today(v_actor.org_id);
  v_errors jsonb := '{}'::jsonb;
  k text;
begin
  select * into v_t from hrms.tasks where id = p_task_id and org_id = v_actor.org_id for update;
  if not found then perform hrms.raise_error('NOT_FOUND'); end if;
  v_old := v_t;
  v_mine := v_t.assigned_to = v_actor.employee_id;
  v_manage := v_t.assigned_by = v_actor.employee_id or 'admin' = any(v_actor.roles)
              or (not v_mine and hrms.can_assign_task(v_actor, v_t.assigned_to));
  if not (v_mine or v_manage) then
    perform hrms.raise_error(case when hrms.can_see_work(v_actor, v_t.assigned_to) then 'ACCESS_DENIED' else 'NOT_FOUND' end);
  end if;
  if p_expected_version is distinct from v_t.version then
    perform hrms.raise_error('STALE_VERSION', 'This task was changed by someone else. Reload and try again.');
  end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    perform hrms.raise_error('VALIDATION_FAILED', 'Nothing to change.');
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('status', 'title', 'description', 'due_date', 'priority') then
      perform hrms.raise_error('VALIDATION_FAILED', 'Unknown field: ' || k);
    end if;
    if k <> 'status' and not v_manage then
      perform hrms.raise_error('ACCESS_DENIED', 'Only the person who gave the task can change its details.');
    end if;
  end loop;
  if v_old.status = 'cancelled' then
    perform hrms.raise_error('VALIDATION_FAILED', 'This task was cancelled.');
  end if;

  if v_status is not null then
    if v_status not in ('todo', 'in_progress', 'done', 'cancelled') then
      v_errors := v_errors || '{"status":"Unknown status"}';
    elsif v_status = 'cancelled' and not v_manage then
      perform hrms.raise_error('ACCESS_DENIED', 'Only the person who gave the task can cancel it.');
    else
      v_t.status := v_status;
      v_t.completed_at := case when v_status = 'done' then coalesce(v_old.completed_at, now()) else null end;
    end if;
  end if;
  if p_patch ? 'title' then
    v_title := hrms.clean_text(p_patch ->> 'title', 200);
    if v_title is null or char_length(v_title) < 2 then v_errors := v_errors || '{"title":"Give the task a title"}'; else v_t.title := v_title; end if;
  end if;
  if p_patch ? 'description' then
    v_t.description := nullif(btrim(coalesce(p_patch ->> 'description', '')), '');
    if char_length(v_t.description) > 4000 then v_errors := v_errors || '{"description":"Keep it under 4000 characters"}'; end if;
  end if;
  if p_patch ? 'priority' then
    if (p_patch ->> 'priority') not in ('low', 'normal', 'high') then v_errors := v_errors || '{"priority":"Choose low, normal or high"}';
    else v_t.priority := p_patch ->> 'priority'; end if;
  end if;
  if p_patch ? 'due_date' then
    begin
      v_t.due_date := nullif(p_patch ->> 'due_date', '')::date;
    exception when others then
      v_errors := v_errors || '{"due_date":"Pick a valid date"}';
    end;
    if v_t.due_date is distinct from v_old.due_date and v_t.due_date is not null
       and (v_t.due_date < v_today or v_t.due_date > v_today + 366) then
      v_errors := v_errors || '{"due_date":"Pick a date from today up to a year ahead"}';
    end if;
  end if;
  if v_errors <> '{}'::jsonb then
    perform hrms.raise_error('VALIDATION_FAILED', 'Please check the highlighted fields.', v_errors);
  end if;

  update hrms.tasks set status = v_t.status, completed_at = v_t.completed_at, title = v_t.title,
         description = v_t.description, priority = v_t.priority, due_date = v_t.due_date,
         updated_at = now(), version = version + 1
   where id = v_t.id returning * into v_t;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id, 'task.update', 'task', v_t.id,
    jsonb_build_object('patch', p_patch, 'from_status', v_old.status), 'business', v_t.assigned_to);

  if v_t.status = 'done' and v_old.status <> 'done' and v_t.assigned_by <> v_actor.employee_id then
    perform hrms.notify(v_t.org_id, v_t.assigned_by, 'task.done', 'Task done: ' || left(v_t.title, 80),
      (select full_name from hrms.employees where id = v_t.assigned_to) || ' marked it as done.', '/tasks/' || v_t.id::text);
  elsif v_t.status = 'cancelled' and v_old.status <> 'cancelled' and v_t.assigned_to <> v_actor.employee_id then
    perform hrms.notify(v_t.org_id, v_t.assigned_to, 'task.cancelled', 'Task cancelled: ' || left(v_t.title, 80),
      'You no longer need to do this.', '/tasks/' || v_t.id::text);
  elsif v_manage and not v_mine and (v_t.title, v_t.description, v_t.due_date, v_t.priority)
        is distinct from (v_old.title, v_old.description, v_old.due_date, v_old.priority) then
    perform hrms.notify(v_t.org_id, v_t.assigned_to, 'task.changed', 'Task changed: ' || left(v_t.title, 80),
      coalesce('Due ' || to_char(v_t.due_date, 'DD Mon') || '.', 'Open it to see what changed.'), '/tasks/' || v_t.id::text);
  end if;
  return hrms.ok(hrms.task_json(v_t, v_actor));
end;
$$;

create or replace function public.get_task(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_t hrms.tasks;
begin
  select * into v_t from hrms.tasks where id = p_task_id and org_id = v_actor.org_id;
  if not found or not (v_t.assigned_to = v_actor.employee_id or v_t.assigned_by = v_actor.employee_id
                       or hrms.can_see_work(v_actor, v_t.assigned_to)) then
    perform hrms.raise_error('NOT_FOUND');
  end if;
  return hrms.ok(hrms.task_json(v_t, v_actor) || jsonb_build_object('logs', (
    select coalesce(jsonb_agg(hrms.work_log_json(w, v_actor) order by w.work_date desc, w.created_at desc), '[]'::jsonb)
    from hrms.work_logs w where w.task_id = v_t.id)));
end;
$$;

-- p_scope: mine (given to me), given (I gave), team (people I can see, not me).
-- p_status: open (todo + in_progress), done, cancelled, all.
create or replace function public.list_tasks(p_scope text default 'mine', p_status text default 'open', p_employee_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_scope text := coalesce(p_scope, 'mine');
  v_status text := coalesce(p_status, 'open');
begin
  if v_scope not in ('mine', 'given', 'team') or v_status not in ('open', 'done', 'cancelled', 'all') then
    perform hrms.raise_error('VALIDATION_FAILED', 'Unknown filter.');
  end if;
  if p_employee_id is not null and not hrms.can_see_work(v_actor, p_employee_id) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  return hrms.ok((
    select coalesce(jsonb_agg(hrms.task_json(t, v_actor)
             order by (t.status in ('todo', 'in_progress')) desc, t.due_date nulls last,
                      case t.priority when 'high' then 0 when 'normal' then 1 else 2 end, t.created_at desc), '[]'::jsonb)
    from (
      select * from hrms.tasks t
      where t.org_id = v_actor.org_id
        and (p_employee_id is null or t.assigned_to = p_employee_id)
        and case v_scope
              when 'mine' then t.assigned_to = v_actor.employee_id
              when 'given' then t.assigned_by = v_actor.employee_id and t.assigned_to <> v_actor.employee_id
              else t.assigned_to <> v_actor.employee_id and hrms.can_see_work(v_actor, t.assigned_to) end
        and case v_status
              when 'open' then t.status in ('todo', 'in_progress')
              when 'all' then true
              else t.status = v_status end
      order by t.created_at desc
      limit 300
    ) t));
end;
$$;

-- People the caller can give tasks to (for the picker).
create or replace function public.list_task_assignees() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
begin
  return hrms.ok((
    select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name,
                                                 'is_me', e.id = v_actor.employee_id)
                              order by e.id <> v_actor.employee_id, e.full_name), '[]'::jsonb)
    from hrms.employees e
    where e.org_id = v_actor.org_id and e.status = 'active' and hrms.can_assign_task(v_actor, e.id)));
end;
$$;

-- -------------------------------------------------------------- work logs

create or replace function public.save_work_log(
  p_id uuid, p_work_date date, p_title text, p_details text,
  p_minutes integer default null, p_task_id uuid default null, p_expected_version integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_today date := hrms.org_today(v_actor.org_id);
  v_title text := hrms.clean_text(p_title, 200);
  v_details text := nullif(btrim(coalesce(p_details, '')), '');
  v_errors jsonb := '{}'::jsonb;
  v_w hrms.work_logs;
  v_day_total integer;
begin
  if p_work_date is null or p_work_date > v_today or p_work_date < v_today - 7 then
    v_errors := v_errors || '{"work_date":"Pick today or one of the last 7 days"}';
  end if;
  if v_title is null or char_length(v_title) < 2 then v_errors := v_errors || '{"title":"Say what you worked on"}'; end if;
  if v_details is null or char_length(v_details) < 2 then v_errors := v_errors || '{"details":"Describe the work in detail"}';
  elsif char_length(v_details) > 4000 then v_errors := v_errors || '{"details":"Keep it under 4000 characters"}'; end if;
  if p_minutes is not null and (p_minutes < 1 or p_minutes > 1440) then v_errors := v_errors || '{"minutes":"Between 1 minute and 24 hours"}'; end if;
  if p_task_id is not null and not exists (select 1 from hrms.tasks where id = p_task_id and org_id = v_actor.org_id
                                           and assigned_to = v_actor.employee_id) then
    v_errors := v_errors || '{"task_id":"Choose one of your tasks"}';
  end if;
  if v_errors <> '{}'::jsonb then
    perform hrms.raise_error('VALIDATION_FAILED', 'Please check the highlighted fields.', v_errors);
  end if;

  if p_id is not null then
    select * into v_w from hrms.work_logs where id = p_id and employee_id = v_actor.employee_id for update;
    if not found then perform hrms.raise_error('NOT_FOUND'); end if;
    if v_w.work_date < v_today - 7 then
      perform hrms.raise_error('VALIDATION_FAILED', 'Reports older than 7 days cannot be changed.');
    end if;
    if p_expected_version is distinct from v_w.version then
      perform hrms.raise_error('STALE_VERSION', 'This entry was changed elsewhere. Reload and try again.');
    end if;
  end if;
  select coalesce(sum(minutes), 0) into v_day_total from hrms.work_logs
  where employee_id = v_actor.employee_id and work_date = p_work_date and id is distinct from p_id;
  if v_day_total + coalesce(p_minutes, 0) > 1440 then
    perform hrms.raise_error('VALIDATION_FAILED', 'A day has only 24 hours.', '{"minutes":"More than 24 hours on this day"}'::jsonb);
  end if;
  if p_id is null and (select count(*) from hrms.work_logs where employee_id = v_actor.employee_id and work_date = p_work_date) >= 50 then
    perform hrms.raise_error('VALIDATION_FAILED', 'At most 50 entries a day.');
  end if;

  if p_id is null then
    insert into hrms.work_logs (org_id, employee_id, work_date, title, details, minutes, task_id)
    values (v_actor.org_id, v_actor.employee_id, p_work_date, v_title, v_details, p_minutes, p_task_id)
    returning * into v_w;
  else
    update hrms.work_logs set work_date = p_work_date, title = v_title, details = v_details, minutes = p_minutes,
           task_id = p_task_id, updated_at = now(), version = version + 1
     where id = p_id returning * into v_w;
  end if;
  return hrms.ok(hrms.work_log_json(v_w, v_actor));
end;
$$;

create or replace function public.delete_work_log(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_w hrms.work_logs;
begin
  select * into v_w from hrms.work_logs where id = p_id and employee_id = v_actor.employee_id for update;
  if not found then perform hrms.raise_error('NOT_FOUND'); end if;
  if v_w.work_date < hrms.org_today(v_actor.org_id) - 7 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Reports older than 7 days cannot be removed.');
  end if;
  delete from hrms.work_logs where id = p_id;
  return hrms.ok(jsonb_build_object('deleted', true));
end;
$$;

-- One person's reports (default: mine) between two dates (at most 62 days).
create or replace function public.list_work_logs(p_employee_id uuid default null, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_emp uuid := coalesce(p_employee_id, v_actor.employee_id);
  v_to date := coalesce(p_to, hrms.org_today(v_actor.org_id));
  v_from date := coalesce(p_from, v_to - 6);
begin
  if not hrms.can_see_work(v_actor, v_emp) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  if v_from > v_to or v_to - v_from > 62 then
    perform hrms.raise_error('VALIDATION_FAILED', 'Pick up to 62 days.');
  end if;
  return hrms.ok(jsonb_build_object('employee', hrms.person_json(v_emp), 'from', v_from, 'to', v_to, 'rows', (
    select coalesce(jsonb_agg(hrms.work_log_json(w, v_actor) order by w.work_date desc, w.created_at), '[]'::jsonb)
    from hrms.work_logs w where w.employee_id = v_emp and w.work_date between v_from and v_to)));
end;
$$;

-- Everyone whose reports the caller may read (not themselves), for one day:
-- their entries, total time, and whether they have written anything.
create or replace function public.list_team_work(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_day date := coalesce(p_date, hrms.org_today(v_actor.org_id));
begin
  if not (hrms.is_hr_or_admin(v_actor) or cardinality(hrms.leads_teams(v_actor.employee_id, hrms.org_today(v_actor.org_id))) > 0) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  return hrms.ok(jsonb_build_object('date', v_day, 'rows', (
    select coalesce(jsonb_agg(x.j order by x.submitted, x.name), '[]'::jsonb)
    from (
      select e.full_name as name,
             exists (select 1 from hrms.work_logs w where w.employee_id = e.id and w.work_date = v_day) as submitted,
             jsonb_build_object(
               'employee', jsonb_build_object('id', e.id, 'code', e.employee_code, 'name', e.full_name,
                                              'tier', hrms.work_tier(e.id, hrms.org_today(v_actor.org_id))),
               'total_minutes', (select coalesce(sum(w.minutes), 0) from hrms.work_logs w where w.employee_id = e.id and w.work_date = v_day),
               'entries', (select coalesce(jsonb_agg(hrms.work_log_json(w, v_actor) order by w.created_at), '[]'::jsonb)
                           from hrms.work_logs w where w.employee_id = e.id and w.work_date = v_day),
               'open_tasks', (select count(*) from hrms.tasks t where t.assigned_to = e.id and t.status in ('todo', 'in_progress'))
             ) as j
      from hrms.employees e
      where e.org_id = v_actor.org_id and e.status = 'active' and e.id <> v_actor.employee_id
        and hrms.can_see_work(v_actor, e.id)
    ) x)));
end;
$$;

-- What the caller may do here (drives which tabs the app shows).
create or replace function public.get_work_access() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor hrms.actor := hrms.current_actor();
  v_leads integer := cardinality(hrms.leads_teams(v_actor.employee_id, hrms.org_today(v_actor.org_id)));
begin
  return hrms.ok(jsonb_build_object(
    'can_view_team', hrms.is_hr_or_admin(v_actor) or v_leads > 0,
    'leads_teams', v_leads,
    'can_assign_others', exists (select 1 from hrms.employees e
                                 where e.org_id = v_actor.org_id and e.status = 'active' and e.id <> v_actor.employee_id
                                   and hrms.can_assign_task(v_actor, e.id))));
end;
$$;

select hrms.apply_api_grants();
