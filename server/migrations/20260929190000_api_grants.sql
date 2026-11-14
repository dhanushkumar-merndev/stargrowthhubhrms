-- [web-hrms] Ported from ~/Documents/Projects/September/HRMS/hrms/supabase/migrations/20260929190000_api_grants.sql
-- [web-hrms]   unchanged

-- Final grant sweep: runs after every feature migration in this batch.
select hrms.apply_api_grants();
