-- web-hrms opaque cookie sessions (20261113100300_web_sessions.sql).
begin;
select test.standard_org();
select test.as_admin_db();

create temp table p1 as select * from test.people where code = 'EMP01';
create temp table p2 as select * from test.people where code = 'EMP02';
grant select on p1, p2 to authenticated;

-- ------------------------------------------------------------ server-only API
select test.ok(not has_function_privilege('authenticated', 'iam.resolve_session(bytea)', 'execute')
           and not has_function_privilege('anon', 'iam.create_session(uuid, bytea, text, text, interval)', 'execute')
           and not has_function_privilege('authenticated', 'iam.password_for_alias(text)', 'execute')
           and not has_function_privilege('authenticated', 'iam.create_user(text, text)', 'execute')
           and not has_function_privilege('authenticated', 'iam.set_password(uuid, text)', 'execute')
           and not has_function_privilege('authenticated', 'iam.delete_user_sessions(uuid, uuid)', 'execute'),
  'SES-001 browsers can never mint, resolve or delete sessions, or read hashes');
select test.ok(has_function_privilege('service_role', 'iam.resolve_session(bytea)', 'execute')
           and has_function_privilege('service_role', 'iam.create_user(text, text)', 'execute'),
  'SES-002 the server role can');

-- ------------------------------------------------------------ input checks
select test.throws($$select iam.create_session((select auth_user_id from p1), '\x00'::bytea, null, null)$$,
  '22023', 'SES-003 a token hash that is not 32 bytes is refused');
select test.throws($$select iam.create_user('x@test.invalid', 'plaintext')$$, '22023',
  'SES-004 a non-argon2id password hash is refused');
select test.throws($$select iam.create_user('x@test.invalid', null)$$, '22023', 'SES-005 a null hash is refused');
select test.throws($$select iam.set_password((select auth_user_id from p1), '$2b$10$bcrypt')$$, '22023',
  'SES-006 set_password refuses other hash formats');
select test.ok(not iam.set_password(gen_random_uuid(), '$argon2id$v=19$x'), 'SES-007 unknown user: set_password is false');

-- ------------------------------------------------------------ create + resolve
create temp table s as
select iam.create_session((select auth_user_id from p1), decode(repeat('a1', 32), 'hex'), 'Firefox ' || repeat('x', 300), 'iphash') id;
select test.ok((select char_length(user_agent) from iam.sessions where id = (select id from s)) = 200,
  'SES-008 user agent is truncated to 200 chars');
select test.ok((select not_after between now() + interval '29 days 23 hours' and now() + interval '30 days 1 minute'
                from iam.sessions where id = (select id from s)), 'SES-009 default lifetime is 30 days');
select test.ok((select r.session_id = (select id from s) and r.user_id = (select auth_user_id from p1)
                       and r.email = (select alias from p1)
                from iam.resolve_session(decode(repeat('a1', 32), 'hex')) r), 'SES-010 a valid token resolves to its user + alias');
select test.ok(not exists (select 1 from iam.resolve_session(decode(repeat('b2', 32), 'hex'))),
  'SES-011 an unknown token resolves to nothing');
select test.ok(not exists (select 1 from iam.resolve_session(null)), 'SES-012 a null token resolves to nothing');
select test.throws($$select iam.create_session((select auth_user_id from p2), decode(repeat('a1', 32), 'hex'), null, null)$$,
  '23505', 'SES-013 two sessions can never share a token hash');

create temp table long_s as
select iam.create_session((select auth_user_id from p1), decode(repeat('c3', 32), 'hex'), null, null, interval '5 years') id;
select test.ok((select not_after <= now() + interval '90 days' from iam.sessions where id = (select id from long_s)),
  'SES-014 a requested lifetime above 90 days is capped');

-- last_seen_at is written at most every 5 minutes
update iam.sessions set last_seen_at = now() - interval '1 minute' where id = (select id from s);
select count(*) from iam.resolve_session(decode(repeat('a1', 32), 'hex'));
select test.ok((select last_seen_at = now() - interval '1 minute' from iam.sessions where id = (select id from s)),
  'SES-015 a recently seen session is not rewritten');
update iam.sessions set last_seen_at = now() - interval '6 minutes' where id = (select id from s);
select count(*) from iam.resolve_session(decode(repeat('a1', 32), 'hex'));
select test.ok((select last_seen_at = now() from iam.sessions where id = (select id from s)),
  'SES-016 last_seen_at is refreshed after 5 minutes');

-- idle and absolute expiry delete the row
update iam.sessions set last_seen_at = now() - interval '14 days' where id = (select id from s);
select test.ok(not exists (select 1 from iam.resolve_session(decode(repeat('a1', 32), 'hex'))),
  'SES-017 a session idle for 14 days is dead');
select test.ok(not exists (select 1 from iam.sessions where id = (select id from s)), 'SES-018 ...and deleted');
update iam.sessions set not_after = now() where id = (select id from long_s);
select test.ok(not exists (select 1 from iam.resolve_session(decode(repeat('c3', 32), 'hex'))),
  'SES-019 a session at its absolute expiry is dead');
select test.ok(not exists (select 1 from iam.sessions where id = (select id from long_s)), 'SES-019b ...and deleted');
update iam.sessions set last_seen_at = now() - interval '13 days 23 hours' where id = (select session_id from p1);
select test.ok(exists (select 1 from iam.sessions where id = (select session_id from p1)), 'SES-020 13d23h idle is still alive');

-- ------------------------------------------------------------ purge + bulk delete
insert into iam.sessions (user_id, token_hash, not_after) values
  ((select auth_user_id from p2), decode(repeat('d4', 32), 'hex'), now() - interval '1 day'),
  ((select auth_user_id from p2), decode(repeat('e5', 32), 'hex'), now() + interval '1 day');
update iam.sessions set last_seen_at = now() - interval '20 days' where token_hash = decode(repeat('e5', 32), 'hex');
select test.ok(iam.purge_expired_sessions() = 2, 'SES-021 purge removes expired and idle sessions');
select test.ok(exists (select 1 from iam.sessions where id = (select session_id from p2)), 'SES-022 purge keeps live ones');

insert into iam.sessions (user_id, token_hash, not_after)
select (select auth_user_id from p2), decode(repeat(to_hex(16 + g), 32), 'hex'), now() + interval '1 day' from generate_series(0, 2) g;
select test.ok(iam.delete_user_sessions((select auth_user_id from p2), (select session_id from p2)) = 3,
  'SES-023 delete_user_sessions keeps the named session');
select test.ok((select count(*) from iam.sessions where user_id = (select auth_user_id from p2)) = 1, 'SES-024 only it remains');

-- ------------------------------------------------------------ password lookup
update iam.users set encrypted_password = '$argon2id$v=19$m=19456,t=2,p=1$x$y' where id = (select auth_user_id from p1);
select test.ok((select user_id = (select auth_user_id from p1) and encrypted_password like '$argon2id$%'
                from iam.password_for_alias('  ' || upper((select alias from p1)) || ' ')),
  'SES-025 alias lookup is case- and space-insensitive');
select test.ok(not exists (select 1 from iam.password_for_alias('nobody@test.invalid')), 'SES-026 unknown alias: no row');

-- ------------------------------------------------------------ self-service devices
insert into iam.sessions (user_id, token_hash, not_after, user_agent)
values ((select auth_user_id from p1), decode(repeat('f6', 32), 'hex'), now() + interval '1 day', 'Phone');
select test.login('EMP01');
select test.ok(jsonb_array_length(public.list_my_sessions() -> 'data') = 2, 'SES-027 I see my two sessions');
select test.ok((select count(*) from jsonb_array_elements(public.list_my_sessions() -> 'data') e
                where (e ->> 'current')::boolean) = 1, 'SES-028 exactly one is marked current');
select test.ok(not (public.list_my_sessions()::text like '%token_hash%') and not (public.list_my_sessions()::text like '%ip_hash%'),
  'SES-029 hashes are never returned');
select test.throws($$select public.end_my_session((select session_id from p2))$$, 'NOT_FOUND',
  'SES-030 I cannot end someone else''s session');
select test.as_admin_db();
select test.ok(exists (select 1 from iam.sessions where id = (select session_id from p2)), 'SES-031 ...it still exists');
select test.login('EMP01');
select test.throws($$select public.end_my_session(gen_random_uuid())$$, 'NOT_FOUND', 'SES-032 unknown session: NOT_FOUND');
select test.ok((public.end_my_other_sessions() -> 'data' ->> 'ended')::int = 1, 'SES-033 end my other sessions');
select test.ok(jsonb_array_length(public.list_my_sessions() -> 'data') = 1, 'SES-034 the current one remains');
select test.as_admin_db();
select test.ok(exists (select 1 from hrms.audit_logs where action = 'auth.sessions_ended'), 'SES-035 ending sessions is audited');

select test.login('EMP02');
select test.ok((public.end_my_session((select session_id from p2)) -> 'data' ->> 'ended')::boolean,
  'SES-036 I can end my current session');
select test.throws('select public.list_my_sessions()', 'AUTH_REQUIRED', 'SES-037 after which the session no longer works');

select set_config('role', 'anon', false);
select set_config('request.jwt.claims', '{"role":"anon"}', false);
select test.throws('select public.list_my_sessions()', '42501', 'SES-038 anonymous callers cannot list sessions');

-- ------------------------------------------------------------ offboarding
select test.as_admin_db();
insert into iam.sessions (user_id, token_hash, not_after)
values ((select auth_user_id from p1), decode(repeat('ab', 32), 'hex'), now() + interval '1 day');
update hrms.employees set status = 'inactive', end_date = current_date where id = (select employee_id from p1);
select test.ok(not exists (select 1 from iam.sessions where user_id = (select auth_user_id from p1)),
  'SES-039 deactivating an employee signs them out everywhere');

rollback;
