-- 0005_fix_thread_bootstrap_and_join.sql — CO-AI live-mode fix
-- Root cause (QA-verified): createLiveThread/seedStarterThread insert a thread
-- with .select('id') → PostgREST uses Prefer: return=representation, which
-- re-runs the SELECT policy (threads_select_member = is_thread_member(id)) on
-- the row being RETURNED. The creator only joins thread_members AFTER the
-- insert, so every thread insert was rejected with 42501 RLS. Fix: record the
-- creator on the row itself so the returned representation is immediately
-- readable, and add a secure share-code join RPC (a joiner can't SELECT a
-- thread they don't belong to, so joining by code needed a definer function).

-- 1) creator column: stamped at insert time (auth.uid()); nullable so
--    service-role (Edge Function) inserts without a JWT still work.
alter table public.threads add column if not exists created_by uuid;
alter table public.threads alter column created_by set default auth.uid();

-- backfill existing rows: creator = earliest thread_members joiner
update public.threads t
set created_by = sub.member_id
from (
  select distinct on (tm.thread_id) tm.thread_id, tm.member_id
  from public.thread_members tm
  order by tm.thread_id, tm.joined_at asc
) sub
where sub.thread_id = t.id and t.created_by is null;

create index if not exists idx_threads_created_by on public.threads (created_by);

-- 2) creator may read their own thread immediately (fixes insert-with-select)
drop policy if exists "threads_select_member" on public.threads;
create policy "threads_select_member" on public.threads
  for select to authenticated
  using (public.is_thread_member(id) or created_by = auth.uid());

-- 3) share-code join without leaking threads to non-members via SELECT.
--    A joiner is NOT a thread member yet, so the rows are unreadable to them;
--    the RPC resolves the code server-side and inserts the membership.
create or replace function public.join_thread_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread uuid;
begin
  select id into v_thread
  from public.threads
  where upper(share_code) = upper(p_code)
  limit 1;

  if v_thread is null then
    raise exception 'unknown share code' using errcode = 'P0001';
  end if;

  insert into public.thread_members (thread_id, member_id)
  values (v_thread, auth.uid())
  on conflict (thread_id, member_id) do nothing;

  return v_thread;
end;
$$;

revoke all on function public.join_thread_by_code(text) from public;
grant execute on function public.join_thread_by_code(text) to authenticated;