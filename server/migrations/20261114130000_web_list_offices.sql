-- device_management (ported from fingertipssl) replaced list_offices with an
-- id/name list of active offices, which hid the geofence, Wi-Fi and site-test
-- details the office settings screen edits. Restore the HRMS version: full
-- office_json for Admin and master-data HR. Callers that only need a picker
-- (the machine form) filter on `active` themselves.
-- office_json also carries the Wi-Fi names (office_wifi_outside_work) and the
-- web-punch office networks so one call fills the office settings screen.
create or replace function hrms.office_json(o hrms.offices) returns jsonb
language sql stable set search_path = ''
as $$
  select jsonb_build_object('id', o.id, 'name', o.name, 'timezone', o.timezone,
    'latitude', extensions.st_y(o.location::extensions.geometry), 'longitude', extensions.st_x(o.location::extensions.geometry),
    'radius_m', o.radius_m, 'max_accuracy_m', o.max_accuracy_m, 'max_sample_age_s', o.max_sample_age_s,
    'strict_mode', o.strict_mode, 'active', o.active, 'calibration_status', o.calibration_status,
    'calibration_notes', o.calibration_notes, 'config_version', o.config_version, 'version', o.version,
    'wifi_ssids', to_jsonb(coalesce(o.wifi_ssids, '{}'::text[])),
    'network_cidrs', to_jsonb(coalesce(o.network_cidrs::text[], '{}'::text[])),
    'assigned_count', (select count(*) from hrms.office_assignments a join hrms.employees e on e.id = a.employee_id
                       where a.office_id = o.id and e.status = 'active'
                         and daterange(a.effective_from, a.effective_to, '[)') @> hrms.org_today(o.org_id)));
$$;

create or replace function public.list_offices() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.current_actor();
begin
  if not (hrms.is_admin(v_actor) or hrms.has_perm(v_actor, 'hr.master_data')) then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  return hrms.ok((select coalesce(jsonb_agg(hrms.office_json(o) order by o.name), '[]'::jsonb)
                  from hrms.offices o where o.org_id = v_actor.org_id));
end;
$$;
