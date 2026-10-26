-- Persist review status atomically and keep the guided demo at two real reviewers.
create or replace function public.cast_diff_approval(p_diff uuid, p_verdict text, p_comment text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_thread uuid; v_required int; v_approvals int; v_rejections int;
begin
  if p_verdict not in ('approve','reject') then raise exception 'invalid approval verdict' using errcode='22023'; end if;
  select thread_id into v_thread from public.diffs where id=p_diff and superseded_at is null and not merged for update;
  if v_thread is null or not public.is_thread_member(v_thread) then raise exception 'diff not available' using errcode='42501'; end if;
  if p_verdict='approve' and not exists (
    select 1 from public.diffs where id=p_diff and evidence_source='executor'
      and evidence->'qa'->>'verdict'='pass' and (evidence->'tests'->>'passed')::boolean
  ) then raise exception 'passing sandbox evidence is required before approval' using errcode='22023'; end if;
  insert into public.approvals(diff_id,member_id,verdict,comment,ts)
  values(p_diff,auth.uid(),p_verdict,p_comment,(extract(epoch from now())*1000)::bigint)
  on conflict(diff_id,member_id) do update set verdict=excluded.verdict,comment=excluded.comment,ts=excluded.ts;
  select case when w.approval_threshold->>'mode'='fixed' then greatest(coalesce((w.approval_threshold->>'min')::int,2),1)
    when w.approval_threshold->>'mode'='all' then greatest(count(tm.member_id)::int,1)
    else greatest(coalesce((w.approval_threshold->>'min')::int,2),(count(tm.member_id)::int/2)+1) end
  into v_required from public.threads t join public.workspaces w on w.id=t.workspace_id
  left join public.thread_members tm on tm.thread_id=t.id where t.id=v_thread group by w.approval_threshold;
  select count(*) filter(where a.verdict='approve'),count(*) filter(where a.verdict='reject') into v_approvals,v_rejections
  from public.approvals a join public.thread_members tm on tm.member_id=a.member_id and tm.thread_id=v_thread where a.diff_id=p_diff;
  update public.diffs set status=case when v_rejections>0 then 'rejected'::public.diff_status
    when v_approvals>=v_required then 'approved'::public.diff_status else 'pending'::public.diff_status end where id=p_diff;
end;
$$;
revoke all on function public.cast_diff_approval(uuid,text,text) from public,anon;
grant execute on function public.cast_diff_approval(uuid,text,text) to authenticated;

create or replace function public.diff_can_merge(p_diff uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.diffs d join public.threads t on t.id = d.thread_id join public.workspaces w on w.id = t.workspace_id
    where d.id = p_diff and d.superseded_at is null and not d.merged and d.status = 'approved'
      and d.evidence_source = 'executor' and coalesce(d.evidence->'qa'->>'verdict', '') = 'pass'
      and coalesce((d.evidence->'tests'->>'passed')::boolean, false)
      and not exists (select 1 from public.approvals x where x.diff_id = d.id and x.verdict = 'reject')
      and (select count(*) from public.approvals a join public.thread_members tm on tm.thread_id = d.thread_id and tm.member_id = a.member_id where a.diff_id = d.id and a.verdict = 'approve') >=
          (select case when w.approval_threshold->>'mode' = 'fixed' then greatest(coalesce((w.approval_threshold->>'min')::int,2),1) when w.approval_threshold->>'mode' = 'all' then greatest(tc.cnt, 1) else greatest(coalesce((w.approval_threshold->>'min')::int, 2), (tc.cnt / 2) + 1) end
           from lateral (select count(*)::int as cnt from public.thread_members tm where tm.thread_id = d.thread_id) tc)
  );
$$;

update public.workspaces set approval_threshold='{"mode":"fixed","min":2}'::jsonb where public_demo;
