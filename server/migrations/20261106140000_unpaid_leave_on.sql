-- [web-hrms] Ported from ~/Documents/Projects/September/HRMS/hrms/supabase/migrations/20261106140000_unpaid_leave_on.sql
-- [web-hrms]   unchanged

-- =============================================================================
-- Unpaid leave (with permission) must be on offer.
--
-- 20261106130000 added the standard Paid / Medical / Unpaid types only where
-- the code was free. An organisation that already had an inactive "UL" kept
-- it inactive, so employees could not ask for unpaid leave with permission.
-- Switch on one unpaid type (UL first, then the oldest) for every
-- organisation that has none active. Returns how many were switched on.
-- =============================================================================

create or replace function hrms.ensure_unpaid_leave_type() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  with pick as (
    select distinct on (lt.org_id) lt.id
    from hrms.leave_types lt
    where lt.category = 'unpaid'
      and not exists (select 1 from hrms.leave_types a
                       where a.org_id = lt.org_id and a.category = 'unpaid' and a.active)
    order by lt.org_id, (lt.code = 'UL') desc, lt.created_at, lt.id
  )
  update hrms.leave_types lt set active = true from pick where lt.id = pick.id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function hrms.ensure_unpaid_leave_type() from public, anon, authenticated;

select hrms.ensure_unpaid_leave_type();
