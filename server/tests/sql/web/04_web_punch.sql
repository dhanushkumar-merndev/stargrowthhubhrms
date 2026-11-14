-- web-hrms browser punching (20261114100000_web_punch.sql): passkey devices,
-- signature counters, office network ranges and the network gate in the commit.
begin;
select test.standard_org();

create or replace function pg_temp.o1() returns uuid language sql security definer as
$$ select id from hrms.offices where name = 'O1' and org_id = test.org('TEST_ORG') $$;
create or replace function pg_temp.at(p_m double precision)
returns table (lat double precision, lng double precision) language sql as $$
  select extensions.st_y(g::extensions.geometry), extensions.st_x(g::extensions.geometry)
  from (select extensions.st_project(location, p_m, 0.785398) as g from hrms.offices where id = pg_temp.o1()) s;
$$;
create or replace function pg_temp.dchal(p_code text, p_ttl interval default '5 minutes') returns uuid language sql security definer as $$
  insert into hrms.device_challenges (org_id, employee_id, nonce, expires_at)
  values (test.org('TEST_ORG'), test.emp(p_code), 'nonce-' || p_code, clock_timestamp() + p_ttl) returning id;
$$;
create or replace function pg_temp.register(p_code text, p_cred text, p_challenge uuid default null) returns jsonb
language plpgsql as $$
declare p test.people; v_ch uuid := coalesce(p_challenge, pg_temp.dchal(p_code));
begin
  select * into p from test.people where code = p_code;
  return public.internal_register_web_device(p.auth_user_id, p.session_id, p.alias, v_ch, 'nonce-' || p_code,
    gen_random_uuid(), repeat('B', 124), p_cred, 0, 'Chrome on Android');
end $$;
create or replace function pg_temp.android(p_code text) returns uuid language sql as $$
  insert into hrms.devices (org_id, employee_id, installation_id, platform, public_key_spki, attestation_level, biometric_bound)
  values (test.org('TEST_ORG'), test.emp(p_code), gen_random_uuid(), 'android', repeat('A', 91), 'hardware', true)
  returning id;
$$;
create or replace function pg_temp.instance(p_code text, p_day date) returns uuid language sql as $$
  insert into hrms.work_schedule_instances (org_id, employee_id, shift_date, kind, is_required, office_id,
    shift_version_id, timezone, start_at, end_at, lunch_paid, grace_seconds, early_entry_seconds, early_credit,
    checkout_extension_seconds, expected_seconds, half_split_at)
  select test.org('TEST_ORG'), test.emp(p_code), p_day, 'workday', true, pg_temp.o1(), sv.id, 'Asia/Kolkata',
         now() - interval '1 hour', now() + interval '8 hours', true, 1800, 1800, false, 7200, 32400, now() + interval '3 hours'
  from hrms.shift_versions sv join hrms.shifts s on s.id = sv.shift_id and s.name = 'General'
  returning id;
$$;
create or replace function pg_temp.punch(p_code text, p_target uuid, p_device uuid, p_integrity jsonb,
                                         p_action text default 'IN') returns jsonb language plpgsql as $$
declare p test.people; v_key uuid := gen_random_uuid(); v_ch uuid;
begin
  select * into p from test.people where code = p_code;
  insert into hrms.punch_challenges (org_id, employee_id, device_id, action, target_id, nonce, expires_at)
  values (test.org('TEST_ORG'), p.employee_id, p_device, p_action, p_target, hrms.random_token(), clock_timestamp() + interval '60 seconds')
  returning id into v_ch;
  return public.internal_commit_punch(p.auth_user_id, p.session_id, p.alias, v_key, 'hash-' || v_key, v_ch,
    p_action, p_target, p_device, pg_temp.o1(), (pg_temp.at(5)).lat, (pg_temp.at(5)).lng, 5,
    clock_timestamp() - interval '2 seconds', clock_timestamp(), p_integrity);
end $$;
create or replace function pg_temp.chal_of(p_code text) returns uuid language sql security definer as $$
  select id from hrms.device_challenges where employee_id = test.emp(p_code) order by created_at limit 1
$$;
create or replace function pg_temp.web_device(p_code text) returns uuid language sql security definer as $$
  select id from hrms.devices where employee_id = test.emp(p_code) and revoked_at is null and platform = 'web'
$$;

-- ------------------------------------------------------------ grants
select test.ok(not has_function_privilege('authenticated',
                 'public.internal_register_web_device(uuid, uuid, text, uuid, text, uuid, text, text, bigint, text)', 'execute')
           and not has_function_privilege('authenticated', 'public.internal_web_device_counter(uuid, bigint)', 'execute')
           and not has_function_privilege('anon', 'public.get_my_web_device()', 'execute')
           and has_function_privilege('authenticated', 'public.get_my_web_device()', 'execute')
           and has_function_privilege('service_role', 'public.internal_web_device_counter(uuid, bigint)', 'execute'),
  'WP-001 browsers cannot register passkeys or move counters directly');

-- ------------------------------------------------------------ table rules
select test.throws($$insert into hrms.devices (org_id, employee_id, installation_id, platform, public_key_spki, attestation_level)
  values (test.org('TEST_ORG'), test.emp('EMP01'), gen_random_uuid(), 'desktop', repeat('A', 91), 'software')$$,
  '23514', 'WP-002 unknown platforms are refused');
select test.throws($$insert into hrms.devices (org_id, employee_id, installation_id, platform, public_key_spki, attestation_level, credential_id)
  values (test.org('TEST_ORG'), test.emp('EMP01'), gen_random_uuid(), 'android', repeat('A', 91), 'hardware', repeat('c', 20))$$,
  '23514', 'WP-003 only web devices carry a passkey id');
select test.throws($$insert into hrms.devices (org_id, employee_id, installation_id, platform, public_key_spki, attestation_level, credential_id)
  values (test.org('TEST_ORG'), test.emp('EMP01'), gen_random_uuid(), 'web', repeat('A', 91), 'software', 'short')$$,
  '23514', 'WP-004 a passkey id must look like base64url (16+ chars)');

-- ------------------------------------------------------------ registration
select test.as_service();
create temp table r1 as select pg_temp.register('EMP01', repeat('k', 22)) res;
select test.ok((select res -> 'data' ->> 'device_id' is not null and res -> 'data' ->> 'credential_id' = repeat('k', 22) from r1),
  'WP-005 a verified passkey registers');
select test.as_admin_db();
select test.ok((select platform = 'web' and attestation_level = 'software' and biometric_bound and sign_count = 0
                       and attestation_summary ->> 'format' = 'webauthn'
                from hrms.devices where id = (select (res -> 'data' ->> 'device_id')::uuid from r1)),
  'WP-006 stored as a user-verified web device');
select test.as_service();
select test.throws(format('select pg_temp.register(''EMP01'', %L, pg_temp.chal_of(''EMP01''))',
                          repeat('m', 22)),
  'VERIFICATION_FAILED', 'WP-007 a registration challenge is single use');
select test.throws(format('select pg_temp.register(''EMP02'', %L)', repeat('k', 22)), 'VERIFICATION_FAILED',
  'WP-008 a passkey id already registered (to anyone) is refused');
select test.throws($$select pg_temp.register('EMP02', 'bad id!')$$, 'VERIFICATION_FAILED',
  'WP-009 a malformed passkey id is refused');
select test.throws($$select pg_temp.register('EMP02', null)$$, 'VERIFICATION_FAILED', 'WP-010 a missing passkey id is refused');
select test.as_admin_db();
create temp table expired as select pg_temp.dchal('EMP02', '-1 second') id;
grant select on expired to service_role;
select test.as_service();
select test.throws(format('select pg_temp.register(''EMP02'', %L, %L)', repeat('n', 22), (select id from expired)),
  'VERIFICATION_FAILED', 'WP-011 an expired registration challenge is refused');
select test.throws(format('select pg_temp.register(''EMP02'', %L, %L)', repeat('n', 22),
                          pg_temp.dchal('EMP03')),
  'VERIFICATION_FAILED', 'WP-012 someone else''s challenge is refused');

create temp table r2 as select pg_temp.register('EMP01', repeat('z', 22)) res;
select test.as_admin_db();
select test.eq((select count(*)::int from hrms.devices where employee_id = test.emp('EMP01') and revoked_at is null), 1,
  'WP-013 a new passkey replaces the old one (one active device)');
select test.ok(exists (select 1 from hrms.notifications where recipient_id = test.emp('EMP01') and kind = 'device.replaced'),
  'WP-014 ...and the employee is told');
select test.ok(exists (select 1 from hrms.audit_logs where action = 'device.registered'
                       and target_id = (select (res -> 'data' ->> 'device_id')::uuid from r2)), 'WP-015 registration is audited');

-- ------------------------------------------------------------ key lookup + my device
select test.as_service();
select test.ok((select k ->> 'credential_id' = repeat('z', 22) and k ->> 'platform' = 'web' and (k ->> 'sign_count')::int = 0
                from (select public.internal_device_key(p.auth_user_id, p.session_id, p.alias, pg_temp.web_device('EMP01')) k
                      from test.people p where code = 'EMP01') s), 'WP-016 key lookup returns the passkey id and counter');
select test.ok((select not (public.internal_device_key(p.auth_user_id, p.session_id, p.alias, pg_temp.web_device('EMP01')) ->> 'found')::boolean
                from test.people p where code = 'EMP02'), 'WP-017 another employee cannot look up my key');
select test.login('EMP01');
select test.eq((select public.get_my_web_device() -> 'data' ->> 'credential_id'), repeat('z', 22), 'WP-018 I see my active passkey');
select test.login('EMP03');
select test.ok((select public.get_my_web_device() -> 'data' = 'null'::jsonb), 'WP-019 no passkey: null');

-- ------------------------------------------------------------ signature counter
select test.as_service();
select test.ok(public.internal_web_device_counter(pg_temp.web_device('EMP01'), 0), 'WP-020 a zero counter stays allowed while stored is zero');
select test.ok(public.internal_web_device_counter(pg_temp.web_device('EMP01'), 5), 'WP-021 an increasing counter is accepted');
select test.ok(not public.internal_web_device_counter(pg_temp.web_device('EMP01'), 5), 'WP-022 a repeated counter is refused');
select test.ok(not public.internal_web_device_counter(pg_temp.web_device('EMP01'), 3), 'WP-023 a lower counter is refused');
select test.ok(not public.internal_web_device_counter(pg_temp.web_device('EMP01'), 0), 'WP-024 dropping back to zero is refused');
select test.ok(public.internal_web_device_counter(pg_temp.web_device('EMP01'), 6), 'WP-025 the next value is accepted');
select test.ok(not public.internal_web_device_counter(pg_temp.web_device('EMP01'), -1)
           and not public.internal_web_device_counter(pg_temp.web_device('EMP01'), null)
           and not public.internal_web_device_counter(gen_random_uuid(), 9), 'WP-026 negative, null or unknown: refused');
select test.as_admin_db();
select test.eq((select sign_count from hrms.devices where id = pg_temp.web_device('EMP01')), 6::bigint, 'WP-027 stored counter is 6');
select test.ok(exists (select 1 from hrms.security_events where kind = 'device.counter_regressed'
                       and employee_id = test.emp('EMP01')), 'WP-028 a regressed counter is a security event');
create temp table a3 as select pg_temp.android('EMP03') id;
grant select on a3 to service_role;
select test.as_service();
select test.ok(not public.internal_web_device_counter((select id from a3), 10), 'WP-029 the counter applies to web devices only');

-- ------------------------------------------------------------ office networks
select test.login('HR01');
select test.throws(format('select public.set_office_networks(%L, array[''10.0.0.0/8''])', pg_temp.o1()), 'ACCESS_DENIED',
  'WP-030 only Admin sets office networks');
select test.ok(jsonb_array_length(public.list_office_networks() -> 'data') = 3, 'WP-031 HR can list them');
select test.login('EMP01');
select test.throws('select public.list_office_networks()', 'ACCESS_DENIED', 'WP-032 employees cannot list them');
select test.login('ADMIN01');
select test.throws(format('select public.set_office_networks(%L, array[''10.0.0.300/8''])', pg_temp.o1()),
  'VALIDATION_FAILED', 'WP-033 an invalid range is refused');
select test.throws(format('select public.set_office_networks(%L, array[''0.0.0.0/0''])', pg_temp.o1()),
  'VALIDATION_FAILED', 'WP-034 the whole internet is not an office network');
select test.throws(format('select public.set_office_networks(%L, array[''::/0''])', pg_temp.o1()),
  'VALIDATION_FAILED', 'WP-035 ...in IPv6 either');
select test.throws(format('select public.set_office_networks(%L, %L::text[])', pg_temp.o1(),
                          (select array_agg('10.0.' || g || '.0/24') from generate_series(1, 21) g)),
  'VALIDATION_FAILED', 'WP-036 at most 20 ranges');
select test.throws(format('select public.set_office_networks(%L, array[''10.0.0.0/8''])', gen_random_uuid()),
  'NOT_FOUND', 'WP-037 unknown office');
select test.as_admin_db();
create temp table other_office (id uuid);
with i as (insert into hrms.offices (org_id, name, timezone, location)
  values (test.org('OTHER_ORG'), 'X', 'Asia/Kolkata', extensions.st_setsrid(extensions.st_makepoint(1, 1), 4326)::extensions.geography)
  returning id) insert into other_office select id from i;
grant select on other_office to authenticated;
select test.login('ADMIN01');
select test.throws(format('select public.set_office_networks(%L, array[''10.0.0.0/8''])', (select id from other_office)),
  'NOT_FOUND', 'WP-038 another org''s office is invisible');
create temp table n1 as select public.set_office_networks(pg_temp.o1(),
  array[' 203.0.113.0/24 ', '203.0.113.0/24', '', '198.51.100.7', '2001:db8:abcd::/48']) res;
select test.eq((select res -> 'data' -> 'network_cidrs' from n1),
  '["203.0.113.0/24", "198.51.100.7/32", "2001:db8:abcd::/48"]'::jsonb, 'WP-039 ranges are trimmed, de-duplicated and normalised');
select test.as_admin_db();
select test.eq((select config_version from hrms.offices where id = pg_temp.o1()), 2, 'WP-040 changing networks bumps the office config');
select test.ok(exists (select 1 from hrms.audit_logs where action = 'office.networks_set'), 'WP-041 ...and is audited');

-- ------------------------------------------------------------ network gate on punches
create temp table pt as select pg_temp.web_device('EMP01') dev, pg_temp.instance('EMP01', date '2030-02-01') inst;
select test.eq((select test.err(pg_temp.punch('EMP01', inst, dev, '{"level":"software"}')) from pt),
  'NETWORK_REQUIRED', 'WP-042 no client address: rejected');
select test.eq((select test.err(pg_temp.punch('EMP01', inst, dev, '{"client_ip":"192.0.2.10"}')) from pt),
  'NETWORK_REQUIRED', 'WP-043 an address outside the office ranges is rejected');
select test.eq((select test.err(pg_temp.punch('EMP01', inst, dev, '{"client_ip":"not-an-ip"}')) from pt),
  'NETWORK_REQUIRED', 'WP-044 a malformed address is rejected (never an error)');
select test.eq((select test.err(pg_temp.punch('EMP01', inst, dev, '{"client_ip":"203.0.114.1"}')) from pt),
  'NETWORK_REQUIRED', 'WP-045 a neighbouring range is rejected');
select test.eq((select test.err(pg_temp.punch('EMP01', inst, dev, jsonb_build_object('client_ip', repeat('1', 100)))) from pt),
  'NETWORK_REQUIRED', 'WP-046 an over-long value is rejected');
select test.ok(not exists (select 1 from hrms.punch_rejections where detail::text like '%192.0.2.10%'),
  'WP-047 the rejected address is not stored');
create temp table ok1 as select pg_temp.punch('EMP01', inst, dev, '{"client_ip":"203.0.113.77","signature_verified":true}') res from pt;
select test.ok((select (res ->> 'ok')::boolean from ok1), 'WP-048 an address inside the office range punches in');
select test.ok((select integrity ->> 'network_match' = 'true' and integrity ->> 'platform' = 'web'
                       and not integrity ? 'client_ip'
                from hrms.attendance_events where id = (select (res -> 'data' ->> 'event_id')::uuid from ok1)),
  'WP-049 the event records the match, never the address');
select test.ok((select policy_snapshot ->> 'network_ranges' = '3'
                from hrms.attendance_events where id = (select (res -> 'data' ->> 'event_id')::uuid from ok1)),
  'WP-050 the policy snapshot records how many ranges applied');
select test.eq((select test.err(pg_temp.punch('EMP01', (select (res -> 'data' -> 'session' ->> 'session_id')::uuid from ok1),
                                              dev, '{"client_ip":"8.8.8.8"}', 'OUT')) from pt),
  'NETWORK_REQUIRED', 'WP-051 check-out is gated too');
select test.ok((select (pg_temp.punch('EMP01', (select (res -> 'data' -> 'session' ->> 'session_id')::uuid from ok1),
                                      dev, '{"client_ip":"198.51.100.7"}', 'OUT') ->> 'ok')::boolean from pt),
  'WP-052 a single-address range matches exactly');

-- IPv6 and phone devices
select test.as_service();
create temp table r3 as select pg_temp.register('EMP02', repeat('q', 30)) res;
select test.as_admin_db();
create temp table pt2 as select pg_temp.web_device('EMP02') dev, pg_temp.instance('EMP02', date '2030-02-02') inst;
select test.ok((select (pg_temp.punch('EMP02', inst, dev, '{"client_ip":"2001:db8:abcd:12::5"}') ->> 'ok')::boolean from pt2),
  'WP-053 IPv6 addresses match IPv6 ranges');
create temp table pt3 as select id dev, pg_temp.instance('EMP03', date '2030-02-03') inst from a3;
select test.eq((select test.err(pg_temp.punch('EMP03', inst, dev, '{"level":"hardware"}')) from pt3),
  'NETWORK_REQUIRED', 'WP-054 phones are held to the office ranges as well');

-- Wi-Fi names: web devices are exempt (browsers cannot read them), phones are not.
update hrms.offices set network_cidrs = '{}', wifi_ssids = array['Office 5G'] where id = pg_temp.o1();
select test.eq((select test.err(pg_temp.punch('EMP03', inst, dev, '{"level":"hardware"}')) from pt3),
  'WIFI_REQUIRED', 'WP-055 phones still need the office Wi-Fi name');
select test.login('ADMIN01');
select public.set_office_networks(pg_temp.o1(), '{}');
select test.as_admin_db();
create temp table pt4 as select pg_temp.android('MGR01') dev, pg_temp.instance('MGR01', date '2030-02-04') inst;
select test.as_service();
create temp table r4 as select pg_temp.register('MGR02', repeat('w', 40)) res;
select test.as_admin_db();
create temp table pt5 as select pg_temp.web_device('MGR02') dev, pg_temp.instance('MGR02', date '2030-02-05') inst;
create temp table ok5 as select pg_temp.punch('MGR02', inst, dev, '{}') res from pt5;
select test.ok((select (res ->> 'ok')::boolean from ok5), 'WP-056 no ranges configured: web punches need no network match');
select test.ok((select integrity -> 'network_match' = 'null'::jsonb
                from hrms.attendance_events where id = (select (res -> 'data' ->> 'event_id')::uuid from ok5)),
  'WP-057 ...and record the match as not applicable');
select test.ok((select test.err(pg_temp.punch('MGR01', inst, dev, '{"wifi_ssid":"office 5g "}')) is null from pt4),
  'WP-058 phone Wi-Fi names still match case- and space-insensitively');

-- revoked web device cannot punch
update hrms.devices set revoked_at = now() where id = (select dev from pt2);
select test.eq((select test.err(pg_temp.punch('EMP02', inst, dev, '{}', 'OUT')) from pt2), 'VERIFICATION_FAILED',
  'WP-059 a revoked passkey cannot punch');

rollback;
