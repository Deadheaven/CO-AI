
do $$
declare w uuid; t uuid; r uuid; d uuid; m1 uuid; m2 uuid; proposal jsonb;
begin
 select id into m1 from public.members where display_name='Acceptance reviewer 1' limit 1;
 select id into m2 from public.members where display_name='Acceptance reviewer 2' limit 1;
 if m1 is null or m2 is null then raise exception 'acceptance identities missing'; end if;
 insert into public.workspaces(name,approval_threshold) values('CO-AI review regression','{"mode":"fixed","min":2}') returning id into w;
 insert into public.threads(workspace_id,name,share_code) values(w,'Review regression','review-'||gen_random_uuid()::text) returning id into t;
 insert into public.thread_members(thread_id,member_id) values(t,m1),(t,m2);
 insert into public.files(thread_id,path,content) values(t,'source.py','old');
 insert into public.agent_runs(thread_id,prompt,state) values(t,'review test','plan') returning id into r;
 proposal:=public.save_agent_proposal(t,r,'["fix"]','[{"path":"source.py","label":"fix","before":"old","after":"new"}]','python -m unittest','/workspace');
 d:=(proposal->'diff_ids'->>0)::uuid;
 perform set_config('request.jwt.claim.sub',m1::text,true);
 begin
  perform public.cast_diff_approval(d,'approve');
  raise exception 'unverified proposal was approved';
 exception when sqlstate '22023' then null;
 end;
 perform * from public.claim_agent_run('review-regression',90,r);
 -- Contract fixture only, all changes rolled back. This is not live execution evidence.
 perform public.record_executor_evidence('review-regression',r,d,'python -m unittest',true,'mock contract fixture',false,'https://sandbox.example/operations/regression');
 perform public.finish_worker_run('review-regression',r,true);
 perform public.cast_diff_approval(d,'approve');
 if not exists(select 1 from public.diffs where id=d and status='pending') then raise exception 'one approval unlocked review'; end if;
 if public.diff_can_merge(d) then raise exception 'one approval unlocked merge'; end if;
 perform set_config('request.jwt.claim.sub',m2::text,true);
 perform public.cast_diff_approval(d,'approve');
 if not exists(select 1 from public.diffs where id=d and status='approved') then raise exception 'two approvals did not persist'; end if;
 if not public.diff_can_merge(d) then raise exception 'two approvals with evidence did not unlock gate'; end if;
 perform public.cast_diff_approval(d,'reject','regression');
 if public.diff_can_merge(d) then raise exception 'rejection failed to lock gate'; end if;
 if not exists(select 1 from public.diffs where id=d and status='rejected') then raise exception 'rejection did not persist'; end if;
end;
$$;
