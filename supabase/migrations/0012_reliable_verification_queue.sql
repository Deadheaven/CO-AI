-- Reserve a thread for one proposal generator and publish a proposal atomically.
-- A verifier can only claim rows that have a persisted command and at least one diff.

drop index if exists public.idx_diffs_revision_hash;
create unique index if not exists idx_diffs_revision_hash
  on public.diffs(run_id, revision_hash);

alter table public.agent_runs add column if not exists verification_queued_at timestamptz;

create or replace function public.begin_agent_run(p_thread uuid, p_run uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext(p_thread::text));
  if not exists (
    select 1 from public.agent_runs where id = p_run and thread_id = p_thread and state = 'queue' and not queued
  ) then
    return false;
  end if;
  if exists (
    select 1 from public.agent_runs r where r.thread_id = p_thread and r.id <> p_run
      and (r.state in ('plan','write','qa') or (r.state = 'queue' and r.queued))
  ) then
    return false;
  end if;
  update public.agent_runs set state = 'plan', queued = false where id = p_run;
  return true;
end;
$$;

create or replace function public.save_agent_proposal(
  p_thread uuid, p_run uuid, p_steps jsonb, p_diffs jsonb,
  p_command text, p_cwd text default '/workspace'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_diff jsonb;
  v_ids uuid[] := '{}'::uuid[];
  v_id uuid;
begin
  if p_steps is null or p_diffs is null or jsonb_typeof(p_steps) <> 'array' or jsonb_typeof(p_diffs) <> 'array' or jsonb_array_length(p_diffs) = 0 then
    raise exception 'proposal requires step and diff arrays with at least one diff' using errcode = '22023';
  end if;
  if p_cwd is null or left(p_cwd, 1) <> '/' then
    raise exception 'verification cwd must be absolute' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(p_thread::text));
  if not exists (select 1 from public.agent_runs where id = p_run and thread_id = p_thread and state in ('plan','write','qa')) then
    raise exception 'run is not generating a proposal' using errcode = '22023';
  end if;

  insert into public.steps(id, thread_id, title, status, owner_id, sort_order, ts)
  select gen_random_uuid(), p_thread, value, case when ordinality = 1 then 'active'::public.step_status else 'todo'::public.step_status end,
    'agent', ordinality - 1, (extract(epoch from clock_timestamp()) * 1000)::bigint
  from jsonb_array_elements_text(p_steps) with ordinality;

  for v_diff in select value from jsonb_array_elements(p_diffs) loop
    if jsonb_typeof(v_diff->'path') is distinct from 'string'
       or jsonb_typeof(v_diff->'after') is distinct from 'string'
       or coalesce(v_diff->>'path','') = '' or v_diff->>'path' ~ '(^/|(^|/)(\.|\.\.)(/|$)|//|/$)' then
      raise exception 'invalid proposal path or content' using errcode = '22023';
    end if;
    if exists (select 1 from public.diffs where run_id = p_run and path = v_diff->>'path') then
      raise exception 'duplicate proposal path' using errcode = '22023';
    end if;
    if coalesce((select content from public.files where thread_id = p_thread and path = v_diff->>'path'), '')
       is distinct from coalesce(v_diff->>'before','') then
      raise exception 'proposal does not match the current source revision' using errcode = '22023';
    end if;
    if exists (select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id where t.id = p_thread and w.public_demo)
       and v_diff->>'path' <> 'payments.py' then
      raise exception 'the guided demo may change payments.py only; its tests are fixed' using errcode = '22023';
    end if;
    v_id := gen_random_uuid();
    insert into public.diffs(
      id, thread_id, run_id, path, label, before, after, status, votes,
      evidence, evidence_source, revision_hash, ts
    ) values (
      v_id, p_thread, p_run, v_diff->>'path', v_diff->>'label', coalesce(v_diff->>'before',''), coalesce(v_diff->>'after',''),
      'pending', '{}'::jsonb,
      coalesce(v_diff->'evidence', '{"qa":{"summary":"No executor evidence recorded.","verdict":"fail","checks":[]}}'::jsonb),
      'unverified',
      encode(extensions.digest((v_diff->>'path') || E'\\000' || coalesce(v_diff->>'before','') || E'\\000' || coalesce(v_diff->>'after',''), 'sha256'), 'hex'),
      (extract(epoch from clock_timestamp()) * 1000)::bigint
    );
    v_ids := array_append(v_ids, v_id);
  end loop;

  update public.agent_runs set execution_command = nullif(trim(p_command), ''), execution_cwd = p_cwd,
    state = case when nullif(trim(p_command), '') is null then 'blocked'::public.run_state else 'queue'::public.run_state end,
    queued = nullif(trim(p_command), '') is not null,
    verification_queued_at = case when nullif(trim(p_command), '') is null then null else now() end
  where id = p_run;
  update public.threads set status = case when nullif(trim(p_command), '') is null then 'blocked'::public.thread_status else 'in_progress'::public.thread_status end,
    ts = (extract(epoch from clock_timestamp()) * 1000)::bigint where id = p_thread;
  return jsonb_build_object('diff_ids', to_jsonb(v_ids), 'queued', nullif(trim(p_command), '') is not null);
end;
$$;

create or replace function public.expire_stale_verification_runs()
returns integer language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  with eligible as (
    select r.id, r.thread_id, r.lease_owner is not null as lease_expired
    from public.agent_runs r
    where (
      (r.state = 'queue' and r.queued and r.verification_queued_at < now() - interval '120 seconds')
      or (r.state = 'qa' and r.lease_owner is not null and r.lease_expires_at < now())
    )
    and (
      exists (select 1 from public.thread_members tm where tm.thread_id = r.thread_id and tm.member_id = auth.uid())
      or exists (
        select 1 from public.threads t join public.workspaces w on w.id = t.workspace_id
        where t.id = r.thread_id and w.public_demo = true
      )
    )
  ), expired as (
    update public.agent_runs r set state = 'blocked', queued = false, lease_owner = null, lease_expires_at = null,
      finished_at = (extract(epoch from now()) * 1000)::bigint
    from eligible e where r.id = e.id
    returning r.id, r.thread_id, e.lease_expired
  ), thread_update as (
    update public.threads t set status = 'blocked', ts = (extract(epoch from now()) * 1000)::bigint
    where t.id in (select e.thread_id from expired)
  )
  insert into public.messages(thread_id, author_id, kind, body, run_id, meta, ts)
  select e.thread_id, 'agent', 'agent',
    case when e.lease_expired
      then 'The sandbox worker lease expired before verification finished. The proposal remains unverified; restart the worker and submit a new run.'
      else 'Sandbox verification did not start within 2 minutes. The proposal is saved but unverified; start the local worker and submit a new run.' end,
    e.id, 'blocked', (extract(epoch from now()) * 1000)::bigint
  from expired e;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.begin_agent_run(uuid, uuid) from public;
revoke all on function public.save_agent_proposal(uuid, uuid, jsonb, jsonb, text, text) from public;
grant execute on function public.begin_agent_run(uuid, uuid) to service_role;
grant execute on function public.save_agent_proposal(uuid, uuid, jsonb, jsonb, text, text) to service_role;
revoke all on function public.expire_stale_verification_runs() from public;
grant execute on function public.expire_stale_verification_runs() to authenticated;

drop function if exists public.claim_agent_run(text, int);
create or replace function public.claim_agent_run(p_worker_id text, p_lease_seconds int default 90, p_run_id uuid default null)
returns table (run_id uuid, thread_id uuid, prompt text, execution_command text, execution_cwd text, base_sha text, attempt int, diff_ids uuid[], files jsonb, patches jsonb)
language plpgsql security definer set search_path = public as $$
declare v_run public.agent_runs%rowtype;
begin
  if length(trim(p_worker_id)) = 0 then raise exception 'worker id is required' using errcode = '22023'; end if;
  if p_lease_seconds < 30 or p_lease_seconds > 600 then raise exception 'lease must be between 30 and 600 seconds' using errcode = '22023'; end if;
  select r.* into v_run from public.agent_runs r
  where r.state = 'queue' and r.queued and r.execution_command is not null
    and (p_run_id is null or r.id = p_run_id)
    and (r.lease_expires_at is null or r.lease_expires_at < now())
    and exists (select 1 from public.diffs d where d.run_id = r.id and d.superseded_at is null)
  order by r.started_at asc for update skip locked limit 1;
  if not found then return; end if;
  update public.agent_runs r set lease_owner = p_worker_id, lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    attempt = r.attempt + 1, state = 'qa', queued = false where r.id = v_run.id returning r.* into v_run;
  return query select v_run.id, v_run.thread_id, v_run.prompt, v_run.execution_command, v_run.execution_cwd, v_run.base_sha, v_run.attempt,
    coalesce((select array_agg(d.id order by d.ts) from public.diffs d where d.run_id = v_run.id and d.superseded_at is null), '{}'::uuid[]),
    coalesce((select jsonb_agg(jsonb_build_object('path', f.path, 'content', f.content) order by f.path) from public.files f where f.thread_id = v_run.thread_id), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'path', d.path, 'after', d.after) order by d.ts) from public.diffs d where d.run_id = v_run.id and d.superseded_at is null), '[]'::jsonb);
end;
$$;

revoke all on function public.claim_agent_run(text, int, uuid) from public;
grant execute on function public.claim_agent_run(text, int, uuid) to service_role;

-- Keep enum types explicit in CASE expressions (untyped branches resolve to text).
create or replace function public.finish_worker_run(p_worker_id text, p_run uuid, p_passed boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_thread uuid;
begin
  select thread_id into v_thread from public.agent_runs
    where id = p_run and lease_owner = p_worker_id and lease_expires_at > now()
    for update;
  if not found then raise exception 'worker lease is missing or expired' using errcode = '42501'; end if;
  perform public.append_worker_event(p_worker_id, p_run, 'run-finished', jsonb_build_object('passed', p_passed));
  update public.agent_runs set state = case when p_passed then 'review'::public.run_state else 'blocked'::public.run_state end,
    lease_owner = null, lease_expires_at = null,
    finished_at = case when p_passed then null else (extract(epoch from now()) * 1000)::bigint end
  where id = p_run;
  update public.threads set status = case when p_passed then 'review'::public.thread_status else 'blocked'::public.thread_status end,
    ts = (extract(epoch from now()) * 1000)::bigint where id = v_thread;
end;
$$;
