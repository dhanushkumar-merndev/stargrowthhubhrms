-- [web-hrms] Background jobs run by the Rust server (replaces pg_cron ->
-- Edge Function wake-ups). A job runs only after it wins an atomic claim, so a
-- restart, a slow run or a second instance can never double-run it.

create table if not exists hrms.job_runs (
  name text primary key check (name ~ '^[a-z][a-z0-9_.-]{1,40}$'),
  last_run_at timestamptz not null default '-infinity',
  last_ok_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  last_detail jsonb,
  runs bigint not null default 0,
  failures bigint not null default 0
);
alter table hrms.job_runs enable row level security;
revoke all on hrms.job_runs from public, anon, authenticated;

-- true when the caller should run the job now.
--   p_every:          minimum gap between runs
--   p_not_before_utc: daily jobs — at most once per UTC date, not before this time
create or replace function public.internal_job_claim(p_name text, p_every interval, p_not_before_utc time default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp();
begin
  if p_every is null or p_every < interval '30 seconds' then
    raise exception 'job interval too short' using errcode = '22023';
  end if;
  insert into hrms.job_runs (name) values (p_name) on conflict (name) do nothing;
  update hrms.job_runs
     set last_run_at = v_now, runs = runs + 1
   where name = p_name
     and last_run_at <= v_now - p_every
     and (p_not_before_utc is null
          or ((v_now at time zone 'utc')::time >= p_not_before_utc
              and (last_run_at = '-infinity' or (last_run_at at time zone 'utc')::date < (v_now at time zone 'utc')::date)));
  return found;
end;
$$;

create or replace function public.internal_job_done(p_name text, p_ok boolean, p_detail jsonb default null, p_error text default null)
returns void
language sql security definer set search_path = '' as $$
  update hrms.job_runs
     set last_ok_at = case when p_ok then clock_timestamp() else last_ok_at end,
         last_error = case when p_ok then null else left(coalesce(p_error, 'failed'), 500) end,
         last_detail = p_detail,
         failures = failures + case when p_ok then 0 else 1 end
   where name = p_name;
$$;

-- Admin health view (business mode, Admin only).
create or replace function public.list_job_runs() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_actor hrms.actor := hrms.current_actor();
begin
  if not hrms.is_admin(v_actor) then perform hrms.raise_error('ACCESS_DENIED'); end if;
  return hrms.ok(coalesce((select jsonb_agg(jsonb_build_object(
      'name', name, 'last_run_at', nullif(last_run_at, '-infinity'), 'last_ok_at', last_ok_at,
      'last_error', last_error, 'runs', runs, 'failures', failures) order by name)
    from hrms.job_runs), '[]'::jsonb));
end;
$$;

-- Session clean-up wrapper so the server calls it like the other jobs.
create or replace function public.internal_purge_expired_sessions() returns integer
language sql security definer set search_path = '' as $$ select iam.purge_expired_sessions() $$;

revoke all on function public.internal_job_claim(text, interval, time), public.internal_job_done(text, boolean, jsonb, text),
  public.internal_purge_expired_sessions() from public, anon, authenticated;
grant execute on function public.internal_job_claim(text, interval, time), public.internal_job_done(text, boolean, jsonb, text),
  public.internal_purge_expired_sessions() to service_role;
revoke all on function public.list_job_runs() from public, anon;
grant execute on function public.list_job_runs() to authenticated;
