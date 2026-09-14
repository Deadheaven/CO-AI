-- 0001_init.sql — CO-AI M1 foundation
-- Tables per PRD §10 + RLS so a signed-in member can only read/write
-- data for threads/workspaces they belong to. Service-role key is NEVER
-- used by the client; it is only available server-side (Edge Functions).

-- ================= Extensions =================
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ================= Enums (match src/types.ts) =================
do $$ begin
  create type public.thread_status as enum ('draft','planning','in_progress','review','shipped','blocked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.msg_kind as enum ('chat','agent','system','diff','copilot');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.step_status as enum ('todo','active','done');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.diff_status as enum ('pending','approved','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.run_state as enum ('queue','plan','write','qa','review','done');
exception when duplicate_object then null; end $$;

-- ================= tables =================

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'CO-AI workspace',
  approval_threshold jsonb not null default '{"mode":"majority","min":2}'::jsonb,
  created_at timestamptz not null default now()
);

-- member profile, keyed by auth user id (anonymous sign-in auto-creates)
create table if not exists public.members (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Member',
  color text not null default '#93c5fd',
  avatar_seed text,
  last_seen timestamptz,
  created_at timestamptz not null default now()
);

insert into public.members (id, display_name, color)
select id, 'Member', '#93c5fd' from auth.users u
where not exists (select 1 from public.members m where m.id = u.id);

create table if not exists public.threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  share_code text not null unique,
  description text not null default '',
  status public.thread_status not null default 'draft',
  ts bigint not null default (extract(epoch from now()) * 1000)::bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_threads_workspace on public.threads(workspace_id);
create index if not exists idx_threads_code on public.threads (share_code);

create table if not exists public.thread_members (
  thread_id uuid not null references public.threads(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (thread_id, member_id)
);
create index if not exists idx_thread_members_member on public.thread_members (member_id);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  author_id text not null, -- member uuid::text, or 'agent'/'system' for harness events
  kind public.msg_kind not null default 'chat',
  body text,
  parent_id uuid,
  run_id text,
  diff_id text,
  meta text,
  ts bigint not null default (extract(epoch from now()) * 1000)::bigint
);
create index if not exists idx_messages_thread on public.messages (thread_id, ts);
create index if not exists idx_messages_thread_kind on public.messages (thread_id, kind);

create table if not exists public.steps (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  title text not null,
  status public.step_status not null default 'todo',
  owner_id text,
  sort_order int not null default 0,
  ts bigint not null default (extract(epoch from now()) * 1000)::bigint
);
create index if not exists idx_steps_thread on public.steps (thread_id);

create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  path text not null,
  content text not null default '',
  updated_by uuid references public.members(id) on delete set null,
  ts bigint not null default (extract(epoch from now()) * 1000)::bigint,
  unique (thread_id, path)
);
create index if not exists idx_files_thread on public.files (thread_id);

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  prompt text not null,
  state public.run_state not null default 'queue',
  log jsonb not null default '[]'::jsonb,
  started_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  finished_at bigint
);
create index if not exists idx_runs_thread on public.agent_runs (thread_id);

create table if not exists public.diffs (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads(id) on delete cascade,
  run_id uuid references public.agent_runs(id) on delete set null,
  path text not null,
  label text not null,
  before text not null default '',
  after text not null default '',
  status public.diff_status not null default 'pending',
  votes jsonb not null default '{}'::jsonb,
  comment text,
  evidence jsonb,
  merged boolean not null default false,
  pr_number int,
  branch text,
  ts bigint not null default (extract(epoch from now()) * 1000)::bigint
);
create index if not exists idx_diffs_thread on public.diffs (thread_id);
create index if not exists idx_diffs_run on public.diffs (run_id);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  diff_id uuid not null references public.diffs(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  verdict text not null check (verdict in ('approve','reject')),
  comment text,
  ts bigint not null default (extract(epoch from now()) * 1000)::bigint,
  unique (diff_id, member_id)
);
create index if not exists idx_approvals_diff on public.approvals (diff_id);

-- ================= RLS =================

alter table public.workspaces enable row level security;
alter table public.members enable row level security;
alter table public.threads enable row level security;
alter table public.thread_members enable row level security;
alter table public.messages enable row level security;
alter table public.steps enable row level security;
alter table public.files enable row level security;
alter table public.agent_runs enable row level security;
alter table public.diffs enable row level security;
alter table public.approvals enable row level security;

-- helper: is the current user a member of this thread?
create or replace function public.is_thread_member(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.thread_members tm
    where tm.thread_id = target
      and tm.member_id = auth.uid()
  );
$$;

-- helper: does the current user belong to the workspace that owns a thread?
create or replace function public.thread_workspace_member(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.threads t
    join public.workspaces w on w.id = t.workspace_id
    where t.id = target
      and exists (
        select 1 from public.thread_members tm
        where tm.thread_id = t.id and tm.member_id = auth.uid()
      )
  );
$$;

-- ---- workspaces: any signed-in member may read/insert (v1: one workspace) ----
create policy "workspace_select_signed_in" on public.workspaces
  for select to authenticated using (auth.uid() is not null);
create policy "workspace_insert_signed_in" on public.workspaces
  for insert to authenticated with check (auth.uid() is not null);
create policy "workspace_update_signed_in" on public.workspaces
  for update to authenticated using ((select count(*) from public.thread_members tm where tm.member_id = auth.uid()) >= 0);

-- ---- members: read others w/ membership; edit self only ----
create policy "members_select_authenticated" on public.members
  for select to authenticated using (auth.uid() is not null);
create policy "members_insert_self" on public.members
  for insert to authenticated with check (id = auth.uid());
create policy "members_update_self" on public.members
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---- threads ----
create policy "threads_select_member" on public.threads
  for select to authenticated using (public.is_thread_member(id));
create policy "threads_insert_member" on public.threads
  for insert to authenticated with check (
    auth.uid() is not null
    and exists (select 1 from public.workspaces w where w.id = workspace_id)
  );
create policy "threads_update_member" on public.threads
  for update to authenticated using (public.is_thread_member(id)) with check (public.is_thread_member(id));

-- ---- thread_members ----
create policy "tm_select_member" on public.thread_members
  for select to authenticated using (member_id = auth.uid() or public.is_thread_member(thread_id));
create policy "tm_insert_self_or_member" on public.thread_members
  for insert to authenticated with check (
    member_id = auth.uid()
    or public.is_thread_member(thread_id)
  );

-- ---- messages ----
create policy "messages_select_member" on public.messages
  for select to authenticated using (public.is_thread_member(thread_id));
create policy "messages_insert_member" on public.messages
  for insert to authenticated with check (public.is_thread_member(thread_id));
create policy "messages_update_own" on public.messages
  for update to authenticated using (author_id = auth.uid()::text);

-- ---- steps ----
create policy "steps_select_member" on public.steps
  for select to authenticated using (public.is_thread_member(thread_id));
create policy "steps_insert_member" on public.steps
  for insert to authenticated with check (public.is_thread_member(thread_id));
create policy "steps_update_member" on public.steps
  for update to authenticated using (public.is_thread_member(thread_id)) with check (public.is_thread_member(thread_id));

-- ---- files ----
create policy "files_select_member" on public.files
  for select to authenticated using (public.is_thread_member(thread_id));
create policy "files_insert_member" on public.files
  for insert to authenticated with check (public.is_thread_member(thread_id));
create policy "files_update_member" on public.files
  for update to authenticated using (public.is_thread_member(thread_id)) with check (public.is_thread_member(thread_id));

-- ---- agent_runs ----
create policy "runs_select_member" on public.agent_runs
  for select to authenticated using (public.is_thread_member(thread_id));
create policy "runs_insert_member" on public.agent_runs
  for insert to authenticated with check (public.is_thread_member(thread_id));
create policy "runs_update_member" on public.agent_runs
  for update to authenticated using (public.is_thread_member(thread_id)) with check (public.is_thread_member(thread_id));

-- ---- diffs ----
create policy "diffs_select_member" on public.diffs
  for select to authenticated using (public.is_thread_member(thread_id));
create policy "diffs_insert_member" on public.diffs
  for insert to authenticated with check (public.is_thread_member(thread_id));
create policy "diffs_update_member" on public.diffs
  for update to authenticated using (public.is_thread_member(thread_id)) with check (public.is_thread_member(thread_id));

-- ---- approvals: can only vote on diffs in threads you belong to; write your own vote ----
create policy "approvals_select_member" on public.approvals
  for select to authenticated using (
    exists (select 1 from public.diffs d where d.id = diff_id and public.is_thread_member(d.thread_id))
  );
create policy "approvals_insert_member" on public.approvals
  for insert to authenticated with check (
    member_id = auth.uid()
    and exists (select 1 from public.diffs d where d.id = diff_id and public.is_thread_member(d.thread_id))
  );
create policy "approvals_update_own" on public.approvals
  for update to authenticated using (member_id = auth.uid()) with check (member_id = auth.uid());

-- ================= updated_at trigger (threads) =================
create or replace function public.touch_thread()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_threads_touch on public.threads;
create trigger trg_threads_touch
  before update on public.threads
  for each row execute function public.touch_thread();