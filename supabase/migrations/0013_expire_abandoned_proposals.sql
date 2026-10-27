-- Reconcile pre-0012 queue rows and interrupted proposal generation.
update public.agent_runs
set verification_queued_at = to_timestamp(started_at / 1000.0)
where state = 'queue' and queued and verification_queued_at is null;

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
      or (r.state in ('queue','plan','write','qa') and not r.queued and r.lease_owner is null
          and r.started_at < (extract(epoch from now() - interval '5 minutes') * 1000)::bigint)
    )
    and public.is_thread_member(r.thread_id)
  ), expired as (
    update public.agent_runs r set state = 'blocked', queued = false, lease_owner = null, lease_expires_at = null,
      finished_at = (extract(epoch from now()) * 1000)::bigint
    from eligible e where r.id = e.id
    returning r.id, r.thread_id, e.lease_expired
  ), thread_update as (
    update public.threads t set status = 'blocked', ts = (extract(epoch from now()) * 1000)::bigint
    where t.id in (select e.thread_id from expired)
      and not exists (
        select 1 from public.agent_runs r where r.thread_id=t.id
        and r.state in ('queue','plan','write','qa') and r.id not in (select e.id from expired e)
      )
  )
  insert into public.messages(thread_id, author_id, kind, body, run_id, meta, ts)
  select e.thread_id, 'agent', 'agent',
    case when e.lease_expired
      then 'Verification was interrupted before its worker finished. This proposal remains unverified; try a new request.'
      else 'This request did not finish in time. Any saved proposal remains unverified; try a new request.' end,
    e.id, 'blocked', (extract(epoch from now()) * 1000)::bigint
  from expired e;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.expire_stale_verification_runs() from public, anon;
grant execute on function public.expire_stale_verification_runs() to authenticated;
