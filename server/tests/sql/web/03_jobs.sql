-- web-hrms background job claims (20261113100400_web_jobs.sql).
begin;
select test.standard_org();
select test.as_admin_db();
delete from hrms.job_runs;

select test.ok(public.internal_job_claim('t.every', interval '10 minutes'), 'JOB-001 a new job is due at once');
select test.ok(not public.internal_job_claim('t.every', interval '10 minutes'), 'JOB-002 a second claim right after loses');
select test.ok((select runs = 1 from hrms.job_runs where name = 't.every'), 'JOB-003 only one run was counted');
update hrms.job_runs set last_run_at = clock_timestamp() - interval '9 minutes' where name = 't.every';
select test.ok(not public.internal_job_claim('t.every', interval '10 minutes'), 'JOB-004 not due before the interval');
update hrms.job_runs set last_run_at = clock_timestamp() - interval '11 minutes' where name = 't.every';
select test.ok(public.internal_job_claim('t.every', interval '10 minutes'), 'JOB-005 due after the interval');
select test.throws($$select public.internal_job_claim('t.fast', interval '5 seconds')$$, '22023',
  'JOB-006 intervals under 30 s are refused (no hot loops)');
select test.throws($$select public.internal_job_claim('t.null', null)$$, '22023', 'JOB-007 a null interval is refused');
select test.throws($$select public.internal_job_claim('Bad Name!', interval '1 hour')$$, '23514', 'JOB-008 job names are checked');

-- daily jobs: once per UTC date, not before the given time
select test.ok(public.internal_job_claim('t.daily', interval '30 seconds', '00:00'), 'JOB-009 a daily job runs the first time');
update hrms.job_runs set last_run_at = (date_trunc('day', now() at time zone 'utc') at time zone 'utc')
 where name = 't.daily';
select test.ok(not public.internal_job_claim('t.daily', interval '30 seconds', '00:00'), 'JOB-010 ...but only once per UTC date');
update hrms.job_runs set last_run_at = clock_timestamp() - interval '1 day 1 hour' where name = 't.daily';
select test.ok(public.internal_job_claim('t.daily', interval '30 seconds', '00:00'), 'JOB-011 ...and again the next date');
select test.ok(not public.internal_job_claim('t.late', interval '30 seconds', '23:59:59.999'),
  'JOB-012 not before its time of day');

-- results
select public.internal_job_done('t.every', false, null, repeat('e', 900));
select test.ok((select failures = 1 and char_length(last_error) = 500 and last_ok_at is null from hrms.job_runs where name = 't.every'),
  'JOB-013 a failure is counted and its error truncated');
select public.internal_job_done('t.every', true, '{"n":3}');
select test.ok((select failures = 1 and last_error is null and last_ok_at is not null and last_detail = '{"n":3}'
                from hrms.job_runs where name = 't.every'), 'JOB-014 a success clears the error and keeps the detail');
select public.internal_job_done('t.unknown', true);
select test.ok(not exists (select 1 from hrms.job_runs where name = 't.unknown'), 'JOB-015 done for an unclaimed job is a no-op');

-- access
select test.ok(not has_function_privilege('authenticated', 'public.internal_job_claim(text, interval, time)', 'execute')
           and not has_function_privilege('authenticated', 'public.internal_job_done(text, boolean, jsonb, text)', 'execute')
           and not has_function_privilege('authenticated', 'public.internal_purge_expired_sessions()', 'execute')
           and not has_table_privilege('authenticated', 'hrms.job_runs', 'select'),
  'JOB-016 browsers cannot claim, finish or read jobs directly');
select test.login('EMP01');
select test.throws('select public.list_job_runs()', 'ACCESS_DENIED', 'JOB-017 employees cannot see job health');
select test.login('HR01');
select test.throws('select public.list_job_runs()', 'ACCESS_DENIED', 'JOB-018 HR cannot see job health');
select test.login('ADMIN01');
select test.ok(jsonb_array_length(public.list_job_runs() -> 'data') = 3, 'JOB-019 Admin sees every job');
select test.ok(not (public.list_job_runs()::text like '%-infinity%'), 'JOB-020 never-run is shown as null');

select test.as_admin_db();
select test.ok(public.internal_purge_expired_sessions() >= 0, 'JOB-021 session purge wrapper works');
rollback;
