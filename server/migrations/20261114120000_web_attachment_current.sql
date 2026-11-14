-- Attachments that are never "published" (bank proof, leave and medical
-- documents) become their record's current version once validated. The bank
-- request check (bank_detail_role_approvals) requires current_version_id to
-- point at the proof; the original flow never set it, so every bank request
-- with proof failed with "Upload the proof again".
create or replace function public.internal_finish_upload_complete(
  p_auth_user_id uuid, p_session_id uuid, p_email text, p_file_version_id uuid,
  p_valid boolean, p_detected_mime text, p_size_bytes bigint, p_sha256 text, p_error text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor hrms.actor := hrms.resolve_actor(p_auth_user_id, p_session_id, p_email, 'business');
  v_ver hrms.file_versions;
begin
  select * into v_ver from hrms.file_versions where id = p_file_version_id for update;
  if not found or v_ver.org_id <> v_actor.org_id or v_ver.uploaded_by <> v_actor.employee_id then
    perform hrms.raise_error('ACCESS_DENIED');
  end if;
  if v_ver.state in ('validated', 'published') then
    return jsonb_build_object('state', v_ver.state, 'sha256', v_ver.sha256, 'size_bytes', v_ver.size_bytes);
  end if;
  if v_ver.state <> 'quarantined' then
    perform hrms.raise_error('VALIDATION_FAILED', 'This upload can no longer be completed.');
  end if;

  update hrms.storage_ledger
     set reserved_bytes = greatest(0, reserved_bytes - v_ver.reserved_bytes),
         used_bytes = used_bytes + case when p_valid then coalesce(p_size_bytes, 0) else 0 end,
         updated_at = now()
   where org_id = v_ver.org_id;

  if p_valid then
    update hrms.file_versions
       set state = 'validated', detected_mime = p_detected_mime, size_bytes = p_size_bytes,
           sha256 = lower(p_sha256), validated_at = now(), reserved_bytes = 0
     where id = v_ver.id
    returning * into v_ver;
    update hrms.file_records set current_version_id = v_ver.id
     where id = v_ver.file_record_id
       and class in ('correction_attachment', 'leave_attachment', 'medical_attachment');
  else
    update hrms.file_versions
       set state = 'rejected', validation_error = left(coalesce(p_error, 'Validation failed'), 300),
           reserved_bytes = 0
     where id = v_ver.id
    returning * into v_ver;
  end if;
  perform hrms.audit(v_actor.org_id, v_actor.employee_id,
    case when p_valid then 'file.validated' else 'file.rejected' end, 'file_version', v_ver.id,
    jsonb_build_object('size_bytes', p_size_bytes, 'detected_mime', p_detected_mime, 'error', p_error), 'business');
  return jsonb_build_object('state', v_ver.state, 'sha256', v_ver.sha256, 'size_bytes', v_ver.size_bytes,
                            'error', v_ver.validation_error);
end;
$$;


-- Proofs uploaded before this fix.
update hrms.file_records r set current_version_id = v.id
  from hrms.file_versions v
 where v.file_record_id = r.id and r.current_version_id is null
   and r.class in ('correction_attachment', 'leave_attachment', 'medical_attachment')
   and v.state in ('validated', 'published');
