-- 0007_live_trust_boundary.sql
-- Make live execution evidence and approval decisions fail closed.

alter type public.run_state add value if not exists 'blocked';

alter table public.agent_runs
  add column if not exists requested_by uuid references public.members(id) on delete set null,
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt int not null default 0,
  add column if not exists base_sha text,
  add column if not exists idempotency_key text;

create unique index if not exists idx_agent_runs_idempotency
  on public.agent_runs(thread_id, idempotency_key) where idempotency_key is not null;

create table if not exists public.run_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs(id) on delete cascade,
  sequence bigint not null,
  actor text not null check (actor in ('user','agent','executor','system')),
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);
create index if not exists idx_run_events_replay on public.run_events(run_id, sequence);
alter table public.run_events enable row level security;
create policy "run_events_select_thread_member" on public.run_events
  for select to authenticated using (
    exists (select 1 from public.agent_runs r where r.id = run_id and public.is_thread_member(r.thread_id))
  );

alter table public.diffs
  add column if not exists revision_hash text,
  add column if not exists base_sha text,
  add column if not exists evidence_source text not null default 'unverified',
  add column if not exists superseded_at timestamptz;

update public.diffs
set revision_hash = encode(digest(path || E'\\000' || before || E'\\000' || after, 'sha256'), 'hex')
where revision_hash is null;
alter table public.diffs alter column revision_hash set not null;
create unique index if not exists idx_diffs_revision_hash on public.diffs(thread_id, revision_hash);

-- Normalized approval writes and status changes happen atomically in Postgres.
create or replace function public.cast_diff_approval(p_diff uuid, p_verdict text, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_thread uuid;
begin
  if p_verdict not in ('approve', 'reject') then raise exception 'invalid approval verdict' using errcode = '22023'; end if;
  select thread_id into v_thread from public.diffs where id = p_diff and superseded_at is null and not merged;
  if v_thread is null or not public.is_thread_member(v_thread) then raise exception 'diff not available' using errcode = '42501'; end if;
  insert into public.approvals(diff_id, member_id, verdict, comment, ts)
  values (p_diff, auth.uid(), p_verdict, p_comment, (extract(epoch from now()) * 1000)::bigint)
  on conflict (diff_id, member_id) do update set verdict = excluded.verdict, comment = excluded.comment, ts = excluded.ts;
  update public.diffs set status = case when p_verdict = 'reject' then 'rejected' else 'pending' end where id = p_diff;
end;
$$;
revoke all on function public.cast_diff_approval(uuid, text, text) from public;
grant execute on function public.cast_diff_approval(uuid, text, text) to authenticated;

-- Browser clients may create only human-authored chat/copilot records.
drop policy if exists "messages_insert_member" on public.messages;
create policy "messages_insert_human_member" on public.messages
  for insert to authenticated with check (
    public.is_thread_member(thread_id) and kind in ('chat', 'copilot') and author_id = auth.uid()::text
  );

-- Agent patches/evidence are worker-owned and therefore immutable to clients.
drop policy if exists "diffs_update_member_no_merge" on public.diffs;
create policy "diffs_update_member_no_merge" on public.diffs for update to authenticated using (false) with check (false);

-- A self-declared model QA card is never merge evidence. Only executor-backed
-- passing tests, current revision approvals, and no rejections unlock a merge.
create or replace function public.diff_can_merge(p_diff uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.diffs d join public.threads t on t.id = d.thread_id join public.workspaces w on w.id = t.workspace_id
    where d.id = p_diff and d.superseded_at is null and not d.merged and d.status = 'approved'
      and d.evidence_source = 'executor' and coalesce(d.evidence->'qa'->>'verdict', '') = 'pass'
      and coalesce((d.evidence->'tests'->>'passed')::boolean, false)
      and not exists (select 1 from public.approvals x where x.diff_id = d.id and x.verdict = 'reject')
      and (select count(*) from public.approvals a join public.thread_members tm on tm.thread_id = d.thread_id and tm.member_id = a.member_id where a.diff_id = d.id and a.verdict = 'approve') >=
          (select case when w.approval_threshold->>'mode' = 'all' then greatest(tc.cnt, 1) else greatest(coalesce((w.approval_threshold->>'min')::int, 2), (tc.cnt / 2) + 1) end
           from lateral (select count(*)::int as cnt from public.thread_members tm where tm.thread_id = d.thread_id) tc)
  );
$$;

do $$ begin
  alter publication supabase_realtime add table public.run_events;
exception when duplicate_object then null; when undefined_object then null;
end $$;
