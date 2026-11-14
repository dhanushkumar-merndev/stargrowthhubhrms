-- web-hrms platform additions: iam identity layer, scheduler cleanup,
-- Web Push subscriptions and live events. Runs on the HRMS harness.
begin;
select test.standard_org();

-- ------------------------------------------------------------------- iam
select test.as_admin_db();
select set_config('request.jwt.claims', '', false);
select test.ok(iam.uid() is null and iam.jwt() = '{}'::jsonb, 'IAM-001 no claims: uid is null, jwt is {}');
select set_config('request.jwt.claims', '{"role":"anon"}', false);
select test.ok(iam.uid() is null and iam.role() = 'anon', 'IAM-002 claims without sub: uid is null');
select set_config('request.jwt.claims', '{"sub":""}', false);
select test.ok(iam.uid() is null, 'IAM-003 empty sub is treated as no user');
select test.throws($$select iam.uid() from (select set_config('request.jwt.claims', '{"sub":"not-a-uuid"}', true)) s$$,
  '22P02', 'IAM-004 a malformed sub never resolves to a user');
select set_config('request.jwt.claims', '', false);

select test.ok(not has_table_privilege('authenticated', 'iam.users', 'select')
           and not has_table_privilege('authenticated', 'iam.sessions', 'select')
           and not has_table_privilege('anon', 'iam.users', 'select')
           and not has_table_privilege('authenticated', 'iam.users', 'update'),
  'IAM-005 API roles cannot read or change login identities or sessions');
select test.ok(has_function_privilege('authenticated', 'iam.uid()', 'execute'),
  'IAM-006 API roles can read their own claims');

-- Session edge cases resolve to AUTH_REQUIRED, never to another person.
create temp table emp01 as select * from test.people where code = 'EMP01';
create temp table emp02 as select * from test.people where code = 'EMP02';
grant select on emp01, emp02 to authenticated;

select test.login('EMP01');
select test.ok((public.get_session_context() -> 'data') is not null, 'IAM-007 a valid session works');

-- someone else's session id
select set_config('request.jwt.claims', jsonb_build_object('sub', (select auth_user_id from emp01), 'role', 'authenticated',
  'session_id', (select session_id from emp02), 'email', (select alias from emp01))::text, false);
select test.throws('select public.get_session_context()', 'AUTH_REQUIRED', 'IAM-008 a session of another user is refused');

-- alias mismatch (claims email is not the issued alias)
select set_config('request.jwt.claims', jsonb_build_object('sub', (select auth_user_id from emp01), 'role', 'authenticated',
  'session_id', (select session_id from emp01), 'email', (select alias from emp02))::text, false);
select test.throws('select public.get_session_context()', 'AUTH_REQUIRED', 'IAM-009 a wrong alias is refused');

-- no session id at all
select set_config('request.jwt.claims', jsonb_build_object('sub', (select auth_user_id from emp01), 'role', 'authenticated',
  'email', (select alias from emp01))::text, false);
select test.throws('select public.get_session_context()', 'AUTH_REQUIRED', 'IAM-010 a token without a session is refused');

-- role claim other than authenticated
select set_config('request.jwt.claims', jsonb_build_object('sub', (select auth_user_id from emp01), 'role', 'service_role',
  'session_id', (select session_id from emp01), 'email', (select alias from emp01))::text, false);
select test.throws('select public.get_session_context()', 'AUTH_REQUIRED', 'IAM-011 a non-user role claim is refused');

-- expired session (not_after in the past)
select test.as_admin_db();
update iam.sessions set not_after = now() - interval '1 second' where id = (select session_id from emp01);
select test.login('EMP01');
select test.throws('select public.get_session_context()', 'AUTH_REQUIRED', 'IAM-012 an expired session is refused');
select test.as_admin_db();
update iam.sessions set not_after = now() + interval '1 hour' where id = (select session_id from emp01);
select test.login('EMP01');
select test.ok((public.get_session_context() -> 'data') is not null, 'IAM-013 a session before its expiry works');

-- signed out (session row deleted)
select test.as_admin_db();
delete from iam.sessions where id = (select session_id from emp01);
select test.login('EMP01');
select test.throws('select public.get_session_context()', 'AUTH_REQUIRED', 'IAM-014 a signed-out session is refused');
select test.as_admin_db();

-- deleting the identity removes its sessions
insert into iam.users (id, email) values ('20000000-0000-4000-8000-000000000001', 'x@test.invalid');
insert into iam.sessions (user_id) values ('20000000-0000-4000-8000-000000000001');
delete from iam.users where id = '20000000-0000-4000-8000-000000000001';
select test.ok(not exists (select 1 from iam.sessions where user_id = '20000000-0000-4000-8000-000000000001'),
  'IAM-015 sessions are removed with their identity');
select test.throws($$insert into iam.users (id, email) values (gen_random_uuid(), (select alias from emp02))$$,
  '23505', 'IAM-016 one identity per alias');

-- -------------------------------------------------------------- scheduler
select test.ok(not exists (select 1 from cron.job where jobname in
                 ('hrms-outbox', 'hrms-tick', 'hrms-daily', 'hrms-holidays', 'hrms-sheets')),
  'CRON-001 Edge-Function wake-up jobs are gone (the Rust server runs them)');
select test.ok(exists (select 1 from cron.job where jobname = 'hrms-device-close-attendance-days'),
  'CRON-002 the SQL-only device day-close job is kept');

-- --------------------------------------------------------------- web push
create or replace function pg_temp.sub(p_endpoint text, p_p256dh text default repeat('B', 87),
  p_auth text default repeat('a', 22), p_extra jsonb default '{}') returns text language sql as $$
  select (jsonb_build_object('endpoint', p_endpoint, 'keys', jsonb_build_object('p256dh', p_p256dh, 'auth', p_auth)) || p_extra)::text
$$;
grant execute on function pg_temp.sub(text, text, text, jsonb) to authenticated;

select test.login('EMP02');
select test.ok((public.register_push_token('30000000-0000-4000-8000-000000000001',
  pg_temp.sub('https://fcm.googleapis.com/fcm/send/abc123', p_extra => '{"expirationTime":null,"junk":"x"}'), 'web') -> 'data' ->> 'registered')::boolean,
  'PUSH-001 a browser subscription is accepted');
select test.as_admin_db();
select test.eq((select token::jsonb ? 'junk' or token::jsonb ? 'expirationTime' from hrms.push_tokens
                where installation_id = '30000000-0000-4000-8000-000000000001' and revoked_at is null), false,
  'PUSH-002 only endpoint + keys are stored');
select test.login('EMP02');
select test.throws($$select public.register_push_token(gen_random_uuid(), pg_temp.sub('http://push.example.com/x'), 'web')$$,
  'VALIDATION_FAILED', 'PUSH-003 a plain-http endpoint is refused');
select test.throws($$select public.register_push_token(gen_random_uuid(), pg_temp.sub('https://push.example.com/x', p_p256dh => 'short'), 'web')$$,
  'VALIDATION_FAILED', 'PUSH-004 a bad public key is refused');
select test.throws($$select public.register_push_token(gen_random_uuid(), pg_temp.sub('https://push.example.com/x', p_auth => 'bad key!!bad key!!'), 'web')$$,
  'VALIDATION_FAILED', 'PUSH-005 a bad auth secret is refused');
select test.throws($$select public.register_push_token(gen_random_uuid(), 'this is definitely not json', 'web')$$,
  'VALIDATION_FAILED', 'PUSH-006 a non-JSON subscription is refused');
select test.throws($$select public.register_push_token(gen_random_uuid(), '["https://push.example.com/x", "keys"]', 'web')$$,
  'VALIDATION_FAILED', 'PUSH-007 a JSON array is refused');
select test.throws($$select public.register_push_token(gen_random_uuid(), pg_temp.sub('https://push.example.com/' || repeat('x', 4100)), 'web')$$,
  'VALIDATION_FAILED', 'PUSH-008 an oversized subscription is refused');
select test.throws($$select public.register_push_token(gen_random_uuid(), pg_temp.sub('https://push.example.com/x'), 'windows')$$,
  'VALIDATION_FAILED', 'PUSH-009 an unknown platform is refused');
select test.throws($$select public.register_push_token(null, pg_temp.sub('https://push.example.com/x'), 'web')$$,
  'VALIDATION_FAILED', 'PUSH-010 an installation id is required');
select test.throws($$select public.register_push_token(gen_random_uuid(), pg_temp.sub('https://push.example.com/x y'), 'web')$$,
  'VALIDATION_FAILED', 'PUSH-011 whitespace in the endpoint is refused');
select test.ok((public.register_push_token(gen_random_uuid(), repeat('t', 40), 'android') -> 'data' ->> 'registered')::boolean,
  'PUSH-012 native tokens still work');

-- The same subscription from a new install replaces the old row (also across people on a shared browser).
select test.login('EMP03');
select public.register_push_token('30000000-0000-4000-8000-000000000002',
  pg_temp.sub('https://fcm.googleapis.com/fcm/send/abc123', p_extra => '{"expirationTime":null}'), 'web');
select test.as_admin_db();
select test.eq((select count(*)::int from hrms.push_tokens where platform = 'web' and revoked_at is null
                and token::jsonb ->> 'endpoint' = 'https://fcm.googleapis.com/fcm/send/abc123'), 1,
  'PUSH-013 one active row per subscription; the previous owner stops receiving');
select test.eq((select employee_id from hrms.push_tokens where platform = 'web' and revoked_at is null
                and token::jsonb ->> 'endpoint' = 'https://fcm.googleapis.com/fcm/send/abc123'), test.emp('EMP03'),
  'PUSH-014 the latest signed-in person owns it');

select test.ok(not has_function_privilege('authenticated', 'public.internal_revoke_push_tokens(text[])', 'execute')
           and not has_function_privilege('anon', 'public.internal_revoke_push_tokens(text[])', 'execute'),
  'PUSH-015 only the server can revoke dead subscriptions');
select test.eq(public.internal_revoke_push_tokens(array[(select token from hrms.push_tokens where platform = 'web' and revoked_at is null limit 1)]), 1,
  'PUSH-016 a dead subscription is revoked by token');
select test.eq(public.internal_revoke_push_tokens(null), 0, 'PUSH-017 revoking nothing is a no-op');

-- ------------------------------------------------------------- live events
select test.ok(not has_table_privilege('authenticated', 'hrms.live_events', 'select')
           and not has_function_privilege('authenticated', 'hrms.publish_live(uuid, text, uuid, text, jsonb)', 'execute')
           and not has_function_privilege('anon', 'public.internal_purge_live_events(interval)', 'execute'),
  'LIVE-001 browsers cannot read or forge live events directly');

delete from hrms.live_events;
insert into hrms.notifications (org_id, recipient_id, event_id, kind, title)
values (test.org('TEST_ORG'), test.emp('EMP01'), gen_random_uuid(), 'test.kind', 'Hello');
select test.ok((select audience = 'employee' and employee_id = test.emp('EMP01') and kind = 'notification.new'
                       and payload - 'id' = '{}'::jsonb from hrms.live_events order by id desc limit 1),
  'LIVE-002 a new notification wakes only its recipient, with the id only');

select test.throws($$select hrms.publish_live(test.org('TEST_ORG'), 'employee', null, 'x.y', '{}')$$,
  '23514', 'LIVE-003 an employee event must name the employee');
select test.throws($$select hrms.publish_live(test.org('TEST_ORG'), 'hr_admin', test.emp('EMP01'), 'x.y', '{}')$$,
  '23514', 'LIVE-004 a group event cannot name one employee');
select test.throws($$select hrms.publish_live(test.org('TEST_ORG'), 'everyone', null, 'x.y', '{}')$$,
  '23514', 'LIVE-005 unknown audiences are refused');
select test.throws($$select hrms.publish_live(test.org('TEST_ORG'), 'org', null, 'Bad Kind!', '{}')$$,
  '23514', 'LIVE-006 event kinds are short dotted names');
select test.throws(format($$select hrms.publish_live(test.org('TEST_ORG'), 'org', null, 'x.y', %L)$$,
                          jsonb_build_object('blob', repeat('x', 2000))),
  '23514', 'LIVE-007 payloads are kept small (ids only)');
select hrms.publish_live(test.org('TEST_ORG'), 'org', null, 'x.y', null);
select test.eq((select payload from hrms.live_events order by id desc limit 1), '{}'::jsonb,
  'LIVE-008 a null payload is stored as {}');

update hrms.live_events set created_at = now() - interval '3 hours' where kind = 'x.y';
select test.eq(public.internal_purge_live_events(), 1, 'LIVE-009 purge removes only old events');
select test.ok(exists (select 1 from hrms.live_events where kind = 'notification.new'),
  'LIVE-010 recent events survive a purge');

-- Ids only increase, so a reconnecting browser can resume after its last id.
select hrms.publish_live(test.org('TEST_ORG'), 'org', null, 'a.b', '{}');
select hrms.publish_live(test.org('TEST_ORG'), 'org', null, 'a.c', '{}');
select test.ok((select array_agg(kind order by id) from hrms.live_events where kind like 'a.%') = array['a.b', 'a.c'],
  'LIVE-011 event ids are ordered for Last-Event-ID resume');

rollback;
