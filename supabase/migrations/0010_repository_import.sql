-- 0010_repository_import.sql
-- Replace one thread's source snapshot atomically from the authenticated Edge Function.
create or replace function public.replace_thread_files(p_thread uuid, p_actor uuid, p_files jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if not exists (select 1 from public.thread_members where thread_id = p_thread and member_id = p_actor) then
    raise exception 'actor is not a thread member' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_files, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_files, '[]'::jsonb)) > 120 then
    raise exception 'repository import exceeds file limit' using errcode = '22023';
  end if;
  delete from public.files where thread_id = p_thread;
  insert into public.files(thread_id, path, content, updated_by, ts)
  select p_thread, item->>'path', item->>'content', p_actor, (extract(epoch from now()) * 1000)::bigint
  from jsonb_array_elements(coalesce(p_files, '[]'::jsonb)) item
  where item->>'path' is not null and item->>'content' is not null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.replace_thread_files(uuid, uuid, jsonb) from public;
grant execute on function public.replace_thread_files(uuid, uuid, jsonb) to service_role;
