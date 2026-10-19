-- Bound the shared, judge-facing demo. Apply only after reviewing that the
-- configured workspace contains the intended public fixture repository.
alter table public.workspaces
  add column if not exists public_demo boolean not null default false;

create unique index if not exists idx_one_public_demo_workspace
  on public.workspaces(public_demo) where public_demo;
insert into public.workspaces(name, public_demo, verification_command, verification_cwd)
values ('CO-AI guided public demo', true, 'python -m unittest', '/workspace')
on conflict do nothing;

-- Workspaces are configured by the deployment owner, never by anonymous
-- visitors to the shared public demo.
drop policy if exists "workspace_update_signed_in" on public.workspaces;
drop policy if exists "workspace_insert_signed_in" on public.workspaces;
create policy "workspace_write_service_role" on public.workspaces
  for all to service_role using (true) with check (true);
create policy "workspace_insert_non_demo" on public.workspaces
  for insert to authenticated with check (auth.uid() is not null and not public_demo);
create policy "workspace_update_non_demo" on public.workspaces
  for update to authenticated using (
    not public_demo and exists (
      select 1 from public.threads t join public.thread_members tm on tm.thread_id = t.id
      where t.workspace_id = workspaces.id and tm.member_id = auth.uid()
    )
  ) with check (
    not public_demo and exists (
      select 1 from public.threads t join public.thread_members tm on tm.thread_id = t.id
      where t.workspace_id = workspaces.id and tm.member_id = auth.uid()
    )
  );
drop policy if exists "workspace_select_signed_in" on public.workspaces;
create policy "workspace_select_scoped" on public.workspaces
  for select to authenticated using (
    auth.uid() is not null and (
      public_demo or exists (
        select 1 from public.threads t join public.thread_members tm on tm.thread_id = t.id
        where t.workspace_id = workspaces.id and tm.member_id = auth.uid()
      )
    )
  );

drop policy if exists "members_select_authenticated" on public.members;
create policy "members_select_thread_colleagues" on public.members
  for select to authenticated using (
    id = auth.uid() or exists (
      select 1 from public.thread_members tm
      where tm.member_id = members.id and public.is_thread_member(tm.thread_id)
    )
  );
drop policy if exists "presence_select_any_member" on public.presence;
create policy "presence_select_thread_colleagues" on public.presence
  for select to authenticated using (
    member_id = auth.uid() or exists (
      select 1 from public.thread_members tm
      where tm.member_id = presence.member_id and public.is_thread_member(tm.thread_id)
    )
  );

-- Any authenticated visitor may collaborate only when the workspace has been
-- explicitly marked as the public fixture. Other workspaces retain membership
-- isolation.
create or replace function public.is_thread_member(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    exists (select 1 from public.thread_members tm where tm.thread_id = target and tm.member_id = auth.uid())
    or exists (
      select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id
      where t.id = target and w.public_demo
    )
  );
$$;

drop policy if exists "threads_insert_member" on public.threads;
create policy "threads_insert_non_demo_workspace" on public.threads
  for insert to authenticated with check (
    auth.uid() is not null and exists (
      select 1 from public.workspaces w where w.id = workspace_id and not w.public_demo
    )
  );

-- Visitors may read and collaborate in the fixture, but cannot replace the
-- source tree, invent review cards, or alter run state outside the agent and
-- worker service-role paths.
drop policy if exists "files_insert_member" on public.files;
create policy "files_insert_non_demo_member" on public.files
  for insert to authenticated with check (
    public.is_thread_member(thread_id) and not exists (
      select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id
      where t.id = thread_id and w.public_demo
    )
  );
drop policy if exists "files_update_member" on public.files;
create policy "files_update_non_demo_member" on public.files
  for update to authenticated using (
    public.is_thread_member(thread_id) and not exists (
      select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id
      where t.id = thread_id and w.public_demo
    )
  ) with check (
    public.is_thread_member(thread_id) and not exists (
      select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id
      where t.id = thread_id and w.public_demo
    )
  );
drop policy if exists "diffs_insert_member" on public.diffs;
create policy "diffs_insert_non_demo_member" on public.diffs
  for insert to authenticated with check (
    public.is_thread_member(thread_id) and not exists (
      select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id
      where t.id = thread_id and w.public_demo
    )
  );
drop policy if exists "runs_insert_member" on public.agent_runs;
create policy "runs_insert_member_bounded" on public.agent_runs
  for insert to authenticated with check (
    public.is_thread_member(thread_id) and (
      (not exists (select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id where t.id = thread_id and w.public_demo))
      or (state = 'queue' and length(prompt) <= 1000 and requested_by = auth.uid())
    )
  );
drop policy if exists "runs_update_member" on public.agent_runs;
create policy "runs_update_non_demo_member" on public.agent_runs
  for update to authenticated using (
    public.is_thread_member(thread_id) and not exists (
      select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id
      where t.id = thread_id and w.public_demo
    )
  ) with check (
    public.is_thread_member(thread_id) and not exists (
      select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id
      where t.id = thread_id and w.public_demo
    )
  );

-- A disposable, synthetic fixture with no connection to a real repository.
with demo_workspace as (
  select id from public.workspaces where public_demo limit 1
), demo_thread as (
  insert into public.threads(workspace_id, name, share_code, description)
  select id, 'Fix duplicate charges on retry', 'DEMO-COAI',
    'Guided fixture: retries can charge a customer twice. Ask the agent to add idempotency, inspect the proposed diff, then review the evidence.'
  from demo_workspace
  on conflict (share_code) do update set description = excluded.description
  returning id
)
insert into public.files(thread_id, path, content)
select t.id, fixture.path, fixture.content
from demo_thread t
cross join (values
  ('payments.py', E'def charge(customer_id: str, amount_cents: int) -> dict:\n    """Create a charge. Retries currently create another charge."""\n    return {"customer_id": customer_id, "amount_cents": amount_cents, "status": "charged"}\n'),
  ('test_payments.py', E'import unittest\nfrom payments import charge\n\nclass PaymentTests(unittest.TestCase):\n    def test_charge_returns_requested_amount(self):\n        result = charge("customer-1", 2500)\n        self.assertEqual(2500, result["amount_cents"])\n        self.assertEqual("charged", result["status"])\n\n    def test_retry_with_same_key_returns_the_original_charge(self):\n        ledger = {}\n        first = charge("customer-1", 2500, idempotency_key="retry-1", ledger=ledger)\n        retry = charge("customer-1", 2500, idempotency_key="retry-1", ledger=ledger)\n        self.assertEqual(first, retry)\n        self.assertEqual(1, len(ledger))\n\nif __name__ == "__main__":\n    unittest.main()\n'),
  ('README.md', E'# Guided payment fixture\n\nSynthetic Python repository for the CO-AI public demo. It contains no customer data or external repository connection.\n')
) as fixture(path, content)
on conflict (thread_id, path) do update set content = excluded.content;

create table if not exists public.public_demo_usage (
  usage_day date not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_count integer not null default 0 check (run_count >= 0),
  primary key (usage_day, user_id)
);
alter table public.public_demo_usage enable row level security;

create table if not exists public.public_demo_daily_budget (
  usage_day date primary key,
  run_count integer not null default 0 check (run_count >= 0)
);
alter table public.public_demo_daily_budget enable row level security;

create or replace function public.reserve_public_demo_run(p_user_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_user_count integer;
  v_global_count integer;
begin
  if p_user_id is null then raise exception 'user is required' using errcode = '22023'; end if;
  -- Serializes global budget decisions; limits are 2 runs per identity and 10
  -- total runs per UTC day. This is a conservative request-count cap, not a
  -- monetary billing meter.
  perform pg_advisory_xact_lock(hashtext('coai-public-demo-budget'));
  select run_count into v_user_count from public.public_demo_usage
    where usage_day = v_day and user_id = p_user_id for update;
  select run_count into v_global_count from public.public_demo_daily_budget
    where usage_day = v_day for update;
  if coalesce(v_user_count, 0) >= 2 or coalesce(v_global_count, 0) >= 10 then return false; end if;
  insert into public.public_demo_usage(usage_day, user_id, run_count)
    values (v_day, p_user_id, 1)
    on conflict (usage_day, user_id) do update set run_count = public.public_demo_usage.run_count + 1;
  insert into public.public_demo_daily_budget(usage_day, run_count)
    values (v_day, 1)
    on conflict (usage_day) do update set run_count = public.public_demo_daily_budget.run_count + 1;
  return true;
end;
$$;
revoke all on function public.reserve_public_demo_run(uuid) from public, anon, authenticated;
grant execute on function public.reserve_public_demo_run(uuid) to service_role;

-- Charge the request cap at the same transaction that creates a queued demo
-- run. This prevents callers from filling the worker queue through direct
-- authenticated table inserts without invoking coai-agent.
create or replace function public.guard_public_demo_run_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id
    where t.id = new.thread_id and w.public_demo
  ) then
    if new.state <> 'queue' or length(new.prompt) > 1000 or new.requested_by is null
       or not public.reserve_public_demo_run(new.requested_by) then
      raise exception 'public demo run limit reached or run is invalid' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_public_demo_run_insert() from public, anon, authenticated;
drop trigger if exists public_demo_run_insert_guard on public.agent_runs;
create trigger public_demo_run_insert_guard
  before insert on public.agent_runs
  for each row execute function public.guard_public_demo_run_insert();

-- Lease renewal for sandbox runs, which may legitimately run for ten minutes.
create or replace function public.renew_worker_lease(p_worker_id text, p_run uuid, p_lease_seconds int default 90)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_lease_seconds < 30 or p_lease_seconds > 600 then raise exception 'lease must be between 30 and 600 seconds' using errcode = '22023'; end if;
  update public.agent_runs set lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    where id = p_run and lease_owner = p_worker_id and lease_expires_at > now();
  if not found then raise exception 'worker lease is missing or expired' using errcode = '42501'; end if;
end;
$$;
revoke all on function public.renew_worker_lease(text, uuid, int) from public, anon, authenticated;
grant execute on function public.renew_worker_lease(text, uuid, int) to service_role;
