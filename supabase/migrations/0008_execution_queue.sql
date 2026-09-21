-- 0008_execution_queue.sql
-- A worker claims one queued run atomically and may write evidence only while
-- it owns an unexpired lease. Browser clients never receive these privileges.

alter table public.agent_runs
  add column if not exists execution_command text,
  add column if not exists execution_cwd text not null default '/workspace';

create index if not exists idx_agent_runs_claimable
  on public.agent_runs(started_at) where state = 'queue';

create or replace function public.claim_agent_run(p_worker_id text, p_lease_seconds int default 90)
returns table (run_id uuid, thread_id uuid, prompt text, execution_command text, execution_cwd text, base_sha text, attempt int, diff_ids uuid[], files jsonb)
language plpgsql security definer set search_path = public as $$
declare v_run public.agent_runs%rowtype;
begin
  if length(trim(p_worker_id)) = 0 then raise exception 'worker id is required' using errcode = '22023'; end if;
  if p_lease_seconds < 30 or p_lease_seconds > 600 then raise exception 'lease must be between 30 and 600 seconds' using errcode = '22023'; end if;
  select * into v_run from public.agent_runs
  where state = 'queue' and (lease_expires_at is null or lease_expires_at < now())
  order by started_at asc for update skip locked limit 1;
  if not found then return; end if;
  update public.agent_runs set lease_owner = p_worker_id, lease_expires_at = now() + make_interval(secs => p_lease_seconds),
    attempt = attempt + 1, state = 'plan', queued = false where id = v_run.id returning * into v_run;
  return query select v_run.id, v_run.thread_id, v_run.prompt, v_run.execution_command, v_run.execution_cwd, v_run.base_sha, v_run.attempt,
    coalesce((select array_agg(d.id order by d.ts) from public.diffs d where d.run_id = v_run.id and d.superseded_at is null), '{}'::uuid[]),
    coalesce((select jsonb_agg(jsonb_build_object('path', f.path, 'content', f.content) order by f.path) from public.files f where f.thread_id = v_run.thread_id), '[]'::jsonb);
end;
$$;

create or replace function public.append_worker_event(p_worker_id text, p_run uuid, p_event_type text, p_payload jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_sequence bigint;
begin
  perform pg_advisory_xact_lock(hashtext(p_run::text));
  if not exists (select 1 from public.agent_runs where id = p_run and lease_owner = p_worker_id and lease_expires_at > now()) then
    raise exception 'worker lease is missing or expired' using errcode = '42501';
  end if;
  select coalesce(max(sequence), 0) + 1 into v_sequence from public.run_events where run_id = p_run;
  insert into public.run_events(run_id, sequence, actor, event_type, payload)
  values (p_run, v_sequence, 'executor', p_event_type, coalesce(p_payload, '{}'::jsonb));
  return v_sequence;
end;
$$;

create or replace function public.record_executor_evidence(
  p_worker_id text, p_run uuid, p_diff uuid, p_command text, p_passed boolean,
  p_output text, p_truncated boolean default false, p_operation_url text default null
) returns void language plpgsql security definer set search_path = public as $$
declare v_summary text;
begin
  if length(trim(p_command)) = 0 then raise exception 'command is required' using errcode = '22023'; end if;
  if not exists (select 1 from public.agent_runs where id = p_run and lease_owner = p_worker_id and lease_expires_at > now()) then
    raise exception 'worker lease is missing or expired' using errcode = '42501';
  end if;
  if not exists (select 1 from public.diffs where id = p_diff and run_id = p_run and superseded_at is null) then
    raise exception 'diff does not belong to leased run' using errcode = '22023';
  end if;
  v_summary := case when p_passed then 'Sandbox command passed.' else 'Sandbox command failed.' end;
  update public.diffs set evidence_source = 'executor', evidence = jsonb_build_object(
    'qa', jsonb_build_object('summary', v_summary, 'verdict', case when p_passed then 'pass' else 'fail' end,
      'checks', jsonb_build_array(jsonb_build_object('name', 'Sandbox command', 'passed', p_passed))),
    'tests', jsonb_build_object('command', p_command, 'passed', p_passed, 'output', p_output,
      'truncated', p_truncated, 'operation_url', p_operation_url)
  ) where id = p_diff;
  perform public.append_worker_event(p_worker_id, p_run, 'verification-complete', jsonb_build_object('diff_id', p_diff, 'passed', p_passed, 'truncated', p_truncated));
end;
$$;

create or replace function public.finish_worker_run(p_worker_id text, p_run uuid, p_passed boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.agent_runs where id = p_run and lease_owner = p_worker_id and lease_expires_at > now()) then
    raise exception 'worker lease is missing or expired' using errcode = '42501';
  end if;
  perform public.append_worker_event(p_worker_id, p_run, 'run-finished', jsonb_build_object('passed', p_passed));
  update public.agent_runs set state = case when p_passed then 'review' else 'blocked' end,
    lease_owner = null, lease_expires_at = null, finished_at = case when p_passed then null else (extract(epoch from now()) * 1000)::bigint end
  where id = p_run;
end;
$$;

revoke all on function public.claim_agent_run(text, int) from public;
revoke all on function public.append_worker_event(text, uuid, text, jsonb) from public;
revoke all on function public.record_executor_evidence(text, uuid, uuid, text, boolean, text, boolean, text) from public;
revoke all on function public.finish_worker_run(text, uuid, boolean) from public;
grant execute on function public.claim_agent_run(text, int) to service_role;
grant execute on function public.append_worker_event(text, uuid, text, jsonb) to service_role;
grant execute on function public.record_executor_evidence(text, uuid, uuid, text, boolean, text, boolean, text) to service_role;
grant execute on function public.finish_worker_run(text, uuid, boolean) to service_role;
