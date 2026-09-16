-- 0004_agent_loop_and_approval_gate.sql — CO-AI M2 + M3
-- M2: agent run queue/trigger fields + realtime for approvals.
-- M3: server-side approval gate function so the merge gate is structural
--     (threshold + evidence), plus diff merge-state tracking columns.

-- ================= M2: agent_runs queue fields =================
alter table public.agent_runs
  add column if not exists trigger text,
  add column if not exists queued boolean not null default false,
  add column if not exists not_configured boolean not null default false;

-- ================= M3: diff merge state =================
alter table public.diffs
  add column if not exists evidence jsonb,
  add column if not exists merged boolean not null default false,
  add column if not exists pr_number int,
  add column if not exists branch text;

-- ================= realtime publication (approvals + files) =================
do $$
begin
  alter publication supabase_realtime add table
    public.approvals,
    public.files;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- ================= M3: server-side gate =================
-- Structural gate, enforced in Postgres so the merge can never bypass it:
-- a diff may only be marked merged when (a) it has passing evidence and
-- (b) approvals >= policy threshold for its thread's team.
create or replace function public.diff_can_merge(p_diff uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.diffs d
    where d.id = p_diff
      and coalesce(d.evidence->'qa'->>'verdict', '') = 'pass'
      and d.status = 'approved'
      and not coalesce(d.merged, false)
      and (
        -- approvals against the thread's team (thread_members)
        select count(*) from public.approvals a
        where a.diff_id = d.id and a.verdict = 'approve'
      ) >= (
        -- required: majority (min 2) of thread members, or 'all'
        select case
          when w.approval_threshold->>'mode' = 'all' then greatest(tc.cnt, 1)
          else greatest(coalesce((w.approval_threshold->>'min')::int, 2), (tc.cnt / 2) + 1)
        end
        from public.threads t
        join public.workspaces w on w.id = t.workspace_id
        cross join lateral (
          select count(*)::int as cnt
          from public.thread_members tm
          where tm.thread_id = t.id
        ) tc
        where t.id = d.thread_id
      )
  );
$$;

-- Helper: can EVERY unmerged diff of a thread merge? Used by coai-gh + UI.
create or replace function public.thread_can_merge(p_thread uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from public.diffs d where d.thread_id = p_thread and not coalesce(d.merged, false))
    and not exists (
      select 1 from public.diffs d
      where d.thread_id = p_thread
        and not coalesce(d.merged, false)
        and not public.diff_can_merge(d.id)
    );
$$;

-- ================= RLS: merged diffs are read-only for members =================
-- (only Edge Functions via service-role may flip `merged` true)
create policy "diffs_update_member_no_merge" on public.diffs
  for update to authenticated
  using (
    public.is_thread_member(thread_id)
    and coalesce(merged, false) = false
  )
  with check (
    public.is_thread_member(thread_id)
    and coalesce(merged, false) = false
  );

drop policy if exists "diffs_update_member" on public.diffs;
