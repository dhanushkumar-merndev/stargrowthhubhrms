-- [web-hrms] The device day board's changes go to the SSE hub too
-- (Supabase Realtime is not available here).
create or replace function hrms.device_day_broadcast() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform hrms.publish_live(new.org_id, 'hr_admin', null, 'device.day',
    jsonb_build_object('employee_id', new.employee_id, 'local_date', new.local_date, 'op', lower(tg_op)));
  return null;
exception when others then
  return null; -- a live-update hiccup must never fail ingest
end;
$$;
