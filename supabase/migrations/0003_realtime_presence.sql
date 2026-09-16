-- 0002_presence_and_realtime.sql — CO-AI M1 realtime presence + live team layer
-- Adds a per-member presence table (join/heartbeat/leave) and puts every table
-- the store renders into the supabase_realtime publication so postgres_changes
-- streams work. Authorization for the streams comes from RLS: a member only
-- ever receives rows their JWT can SELECT.

-- ================= presence =================
create table if not exists public.presence (
  member_id uuid primary key references public.members(id) on delete cascade,
  name text not null default '',
  color text not null default '#93c5fd',
  last_seen timestamptz not null default now()
);

create index if not exists idx_presence_last_seen on public.presence (last_seen);

alter table public.presence enable row level security;

-- any signed-in member may see who's online (v1: single shared workspace)
create policy "presence_select_any_member" on public.presence
  for select to authenticated using (auth.uid() is not null);

-- you may only publish/clear your own presence row
create policy "presence_write_own" on public.presence
  for all to authenticated
  using (member_id = auth.uid())
  with check (member_id = auth.uid());

-- ================= realtime publication =================
-- Stream the tables the client renders. RLS filters each row server-side.
do $$
begin
  alter publication supabase_realtime add table
    public.presence,
    public.members,
    public.messages,
    public.steps,
    public.diffs,
    public.agent_runs,
    public.threads;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;