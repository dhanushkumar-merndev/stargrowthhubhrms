-- [web-hrms] Ported from ~/Documents/Projects/november/fingertipssl/supabase/tests/attendance_rules_test.sql
-- [web-hrms]   unchanged

-- Attendance day rules: 10-minute duplicates, first IN / last OUT, automatic
-- "forgot to checkout", late real OUT, HR corrections, settings, the day board.
-- Runs after _prelude.sql (pnpm db:test). Uses fixed times on past days so it
-- never depends on the time of day it runs.

\set admin '''10000000-0000-4000-8000-000000000001'''
update hrms.employees set auth_user_id = :admin::uuid where employee_code = 'DEMO-001';

-- 'YYYY-MM-DD HH:MI:SS' on the local day p_days_ago days before today.
create function pg_temp.at(p_days_ago integer, p_time text) returns text language sql as $$
  select to_char(((now() at time zone 'Asia/Kolkata')::date - p_days_ago) + p_time::time, 'YYYY-MM-DD HH24:MI:SS');
$$;
create function pg_temp.ts(p_days_ago integer, p_time text) returns timestamptz language sql as $$
  select (((now() at time zone 'Asia/Kolkata')::date - p_days_ago) + p_time::time) at time zone 'Asia/Kolkata';
$$;
create function pg_temp.day(p_days_ago integer) returns date language sql as $$
  select (now() at time zone 'Asia/Kolkata')::date - p_days_ago;
$$;
-- One machine upload of the given (pin, time) pairs.
create function pg_temp.upload(p_secret text, p_pairs text[][]) returns jsonb language plpgsql as $$
declare v jsonb := '[]'::jsonb;
begin
  for i in 1 .. array_length(p_pairs, 1) loop
    v := v || jsonb_build_object('line', i, 'pin', p_pairs[i][1], 'device_time', p_pairs[i][2], 'status', '0', 'verify', '1');
  end loop;
  return public.internal_ingest_device_punches(p_secret, 'SIMESSL0001', null, 'ip', v, null);
end $$;
create function pg_temp.kinds(p_pin text, p_day date) returns text[] language sql as $$
  select array_agg(scan_kind order by device_time) from hrms.device_punch_events
  where pin = p_pin and device_local_time::date = p_day;
$$;
create function pg_temp.row(p_code text, p_day date) returns hrms.device_attendance_days language sql as $$
  select d.* from hrms.device_attendance_days d join hrms.employees e on e.id = d.employee_id
  where e.employee_code = p_code and d.local_date = p_day;
$$;

do $$ begin
  execute format('grant execute on all functions in schema %I to authenticated, service_role', pg_my_temp_schema()::regnamespace::text);
end $$;

-- ------------------------------------------------------------------ privileges
select pg_temp.assert(not has_table_privilege('authenticated', 'hrms.device_attendance_days', 'select'),
  'authenticated has no table access to day rows');
select pg_temp.assert(not has_function_privilege('anon', 'public.list_attendance_day(text)', 'execute'),
  'anon cannot read the day board');
select pg_temp.assert(not has_function_privilege('authenticated', 'hrms.device_close_days()', 'execute'),
  'the close job is not callable by users');
select pg_temp.assert(exists (select 1 from cron.job where jobname = 'hrms-device-close-attendance-days'
                              and schedule = '*/5 * * * *'),
  'the close job is scheduled every 5 minutes');

-- --------------------------------------------- duplicates + first IN / last OUT
-- Asha (PIN 1), 3 days ago: two repeats inside 10 min, lunch out/in, evening out.
select pg_temp.upload(:secret, array[
  array['1', pg_temp.at(3, '09:00:00')], array['1', pg_temp.at(3, '09:05:00')], array['1', pg_temp.at(3, '09:09:59')],
  array['1', pg_temp.at(3, '13:00:00')], array['1', pg_temp.at(3, '14:00:00')], array['1', pg_temp.at(3, '18:10:00')]]);
select pg_temp.assert(pg_temp.kinds('1', pg_temp.day(3)) = array['in', 'duplicate', 'duplicate', 'extra', 'extra', 'out'],
  'repeats within 10 min are duplicates; first = IN, last = OUT, middle = extra');
select pg_temp.assert((select count(*) filter (where counted) = 4 and count(*) filter (where not counted) = 2
                       from hrms.device_punch_events where pin = '1'),
  'duplicates are stored but not counted');
select pg_temp.assert((select first_in_at = pg_temp.ts(3, '09:00') and out_at = pg_temp.ts(3, '18:10')
                              and out_source = 'device' and worked_minutes = 550 and duplicate_count = 2
                              and extra_count = 2 and scan_count = 4 and not forgot_checkout
                       from pg_temp.row('DEMO-001', pg_temp.day(3))),
  'day row: IN 09:00, OUT 18:10, 550 min, 2 duplicates, 2 extra');

-- Rahul (PIN 4), 3 days ago: exactly 10 min counts; a repeat after the OUT is a duplicate.
select pg_temp.upload(:secret, array[
  array['4', pg_temp.at(3, '08:00:00')], array['4', pg_temp.at(3, '08:10:00')], array['4', pg_temp.at(3, '08:15:00')]]);
select pg_temp.assert(pg_temp.kinds('4', pg_temp.day(3)) = array['in', 'out', 'duplicate'],
  'a scan exactly 10 min later counts; a repeat within 10 min of the OUT is a duplicate');
select pg_temp.assert((select out_at = pg_temp.ts(3, '08:10') and worked_minutes = 10 from pg_temp.row('DEMO-004', pg_temp.day(3))),
  'the OUT stays at the counted scan');

-- An upload that arrives out of order re-labels the whole day.
select pg_temp.upload(:secret, array[array['4', pg_temp.at(3, '07:30:00')]]);
select pg_temp.assert(pg_temp.kinds('4', pg_temp.day(3)) = array['in', 'extra', 'out', 'duplicate'],
  'an earlier scan uploaded late becomes the IN and the rest are re-labelled');
select pg_temp.upload(:secret, array[array['4', pg_temp.at(3, '07:30:00')]]);
select pg_temp.assert((select count(*) = 4 from hrms.device_punch_events where pin = '4'), 'a re-sent scan is still deduplicated');

-- -------------------------------------------------- forgot to checkout (auto)
-- Vikram (PIN 2), 3 days ago: only an IN.
select pg_temp.upload(:secret, array[array['2', pg_temp.at(3, '09:30:00')]]);
select pg_temp.assert((select out_at is null and out_source is null and not forgot_checkout
                       from pg_temp.row('DEMO-002', pg_temp.day(3))),
  'an IN-only day is open until the close job runs');

-- Meera (PIN 3), 3 days ago: only an IN; HR fixes it before the job runs.
select pg_temp.upload(:secret, array[array['3', pg_temp.at(3, '10:00:00')]]);

-- Today: an IN-only day is never closed early.
select pg_temp.upload(:secret, array[array['4', pg_temp.at(0, '00:00:01')]]);

-- ----------------------------------------------------------- HR corrections
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert(pg_temp.err(format($$select public.correct_attendance_day(%L, %L, '09:00', 'left early')$$,
                        '00000000-0000-4000-8000-0000000000e3', pg_temp.day(3))) = 'VALIDATION_FAILED',
  'a correction before the IN is refused');
select pg_temp.assert(pg_temp.err(format($$select public.correct_attendance_day(%L, %L, '17:30', '')$$,
                        '00000000-0000-4000-8000-0000000000e3', pg_temp.day(3))) = 'VALIDATION_FAILED',
  'a correction needs a reason');
select pg_temp.assert(pg_temp.err(format($$select public.correct_attendance_day(%L, %L, '17:30', 'forgot')$$,
                        '00000000-0000-4000-8000-0000000000e5', pg_temp.day(3))) = 'NOT_FOUND',
  'no correction without a check-in');
select public.correct_attendance_day('00000000-0000-4000-8000-0000000000e3', pg_temp.day(3)::text, '17:30', 'Forgot to scan; confirmed by manager');
reset role;
select pg_temp.assert((select out_source = 'hr' and out_at = pg_temp.ts(3, '17:30') and worked_minutes = 450
                              and correction_reason like 'Forgot to scan%' and corrected_by = '00000000-0000-4000-8000-0000000000e2'
                       from pg_temp.row('DEMO-003', pg_temp.day(3))),
  'HR correction sets the OUT, worked time and who/why');
select pg_temp.assert((select count(*) = 1 from hrms.audit_logs where action = 'attendance_day.correct' and created_at = now()),
  'the correction is audited');
select pg_temp.assert((select count(*) = 1 from hrms.device_punch_events where pin = '3'), 'raw punches are untouched by a correction');

-- ------------------------------------------------------------- the close job
select pg_temp.assert(hrms.device_close_days() = 1, 'the close job closes exactly the one finished IN-only day');
select pg_temp.assert((select out_source = 'auto' and forgot_checkout and worked_minutes is null
                              and out_at = pg_temp.ts(3, '23:59:59') and auto_closed_at is not null
                       from pg_temp.row('DEMO-002', pg_temp.day(3))),
  'forgot to checkout: automatic OUT at 23:59:59, no worked time');
select pg_temp.assert((select out_source = 'hr' and not forgot_checkout from pg_temp.row('DEMO-003', pg_temp.day(3))),
  'a day HR already fixed is not auto-closed');
select pg_temp.assert((select out_at is null and auto_closed_at is null from pg_temp.row('DEMO-004', pg_temp.day(0))),
  'today stays open');
select pg_temp.assert(hrms.device_close_days() = 0, 'the close job is idempotent');

-- A real OUT that uploads late replaces the automatic one.
select pg_temp.upload(:secret, array[array['2', pg_temp.at(3, '18:00:00')]]);
select pg_temp.assert((select out_source = 'device' and not forgot_checkout and worked_minutes = 510
                              and out_at = pg_temp.ts(3, '18:00')
                       from pg_temp.row('DEMO-002', pg_temp.day(3))),
  'a late real OUT removes the forgot-to-checkout tag');

-- Clearing a correction on an IN-only past day lets the job close it.
select pg_temp.as_user(:hr::uuid);
select public.correct_attendance_day('00000000-0000-4000-8000-0000000000e3', pg_temp.day(3)::text, '', 'Entered by mistake');
reset role;
select pg_temp.assert((select out_source is null and corrected_out_at is null from pg_temp.row('DEMO-003', pg_temp.day(3))),
  'clearing a correction re-opens the day');
select pg_temp.assert(hrms.device_close_days() = 1 and (select out_source = 'auto' from pg_temp.row('DEMO-003', pg_temp.day(3))),
  'and the job then closes it');

-- -------------------------------------------------- linking an unmatched PIN
select pg_temp.upload(:secret, array[array['7', pg_temp.at(3, '11:00:00')]]);
select pg_temp.assert(not exists (select 1 from hrms.device_attendance_days where local_date = pg_temp.day(3)
                                  and employee_id = '00000000-0000-4000-8000-0000000000e5'),
  'unmatched punches make no day row');
select pg_temp.as_user(:hr::uuid);
select public.link_device_user('7', '00000000-0000-4000-8000-0000000000e5', null);
reset role;
select pg_temp.assert((select scan_count = 1 from pg_temp.row('DEMO-005', pg_temp.day(3))),
  'linking the PIN builds the day row');
select pg_temp.assert(hrms.device_close_days() = 1, 'a linked IN-only past day is closed by the next job run');

-- ---------------------------------------------------------------- settings
select pg_temp.as_user(:hr::uuid);
select pg_temp.assert(pg_temp.err($$select public.save_attendance_settings('{"duplicate_window_minutes":5}')$$) = 'ACCESS_DENIED',
  'HR cannot change the rules');
select pg_temp.assert((public.get_attendance_settings() -> 'data' ->> 'duplicate_window_minutes')::int = 10,
  'HR can read the rules (default 10 min)');
select pg_temp.as_user(:admin::uuid);
select pg_temp.assert(pg_temp.err($$select public.save_attendance_settings('{"duplicate_window_minutes":0}')$$) = 'VALIDATION_FAILED',
  'the window must be 1–60 minutes');
select public.save_attendance_settings('{"duplicate_window_minutes":15,"auto_checkout_enabled":false}');
reset role;
select pg_temp.assert((select duplicate_window_minutes = 15 and not auto_checkout_enabled from hrms.device_attendance_settings
                       where org_id = '00000000-0000-4000-8000-000000000001'),
  'Admin saves the rules');
select pg_temp.assert((select count(*) = 1 from hrms.audit_logs where action = 'attendance.settings' and created_at = now()),
  'rule changes are audited');
select pg_temp.assert(pg_temp.kinds('4', pg_temp.day(3)) = array['in', 'extra', 'out', 'duplicate'],
  'a new window does not rewrite past days');

-- Auto checkout off: a finished IN-only day stays open (shown as "no checkout").
select pg_temp.upload(:secret, array[array['1', pg_temp.at(2, '09:00:00')]]);
select pg_temp.assert(hrms.device_close_days() = 0 and (select out_source is null from pg_temp.row('DEMO-001', pg_temp.day(2))),
  'with auto checkout off the job leaves days open');

-- --------------------------------------------------------------- day board
select pg_temp.as_user(:hr::uuid);
select set_config('test.board', (public.list_attendance_day(pg_temp.day(3)::text) -> 'data')::text, true);
select pg_temp.assert((select jsonb_object_agg(r -> 'employee' ->> 'code', r ->> 'status')
                       from jsonb_array_elements(current_setting('test.board')::jsonb -> 'rows') r)
                      = '{"DEMO-001":"checked_out","DEMO-002":"checked_out","DEMO-003":"forgot_checkout",
                          "DEMO-004":"checked_out","DEMO-005":"forgot_checkout"}'::jsonb,
  'board statuses for a past day; inactive people without a record are not listed');
select pg_temp.assert((select (r ->> 'duplicate_count')::int = 2 and (r ->> 'extra_count')::int = 2
                       from jsonb_array_elements(current_setting('test.board')::jsonb -> 'rows') r
                       where r -> 'employee' ->> 'code' = 'DEMO-001'),
  'the board carries the duplicate count once per person');
select pg_temp.assert((select jsonb_object_agg(r -> 'employee' ->> 'code', r ->> 'status')
                       from jsonb_array_elements(public.list_attendance_day(null) -> 'data' -> 'rows') r)
                      @> '{"DEMO-004":"in_office","DEMO-001":"not_in"}'::jsonb,
  'today: in office / not in yet');
select pg_temp.assert((select r ->> 'status' = 'no_checkout'
                       from jsonb_array_elements(public.list_attendance_day(pg_temp.day(2)::text) -> 'data' -> 'rows') r
                       where r -> 'employee' ->> 'code' = 'DEMO-001'),
  'past IN-only day with auto checkout off = no checkout');
select pg_temp.assert(pg_temp.err(format($$select public.list_attendance_day(%L)$$, pg_temp.day(-1))) = 'VALIDATION_FAILED',
  'future dates are refused');
select pg_temp.assert((select bool_and(p ? 'kind') and count(*) > 0
                       from jsonb_array_elements(public.list_device_punches('{"limit":200}') -> 'data') p),
  'the punch feed carries the scan label');
select pg_temp.as_user(:member::uuid);
select pg_temp.assert(pg_temp.err('select public.list_attendance_day(null)') = 'ACCESS_DENIED', 'members cannot see the board');
select pg_temp.assert(pg_temp.err($$select public.correct_attendance_day('00000000-0000-4000-8000-0000000000e4', '2026-01-01', '18:00', 'nope')$$)
                      = 'ACCESS_DENIED', 'members cannot correct days');
reset role;

\echo 'ALL ATTENDANCE RULE TESTS PASSED'
rollback;
