
do $$
declare
 w uuid; t uuid; r uuid; r2 uuid; d uuid; claimed record; proposal jsonb; n int;
begin
 insert into public.workspaces(name) values ('CO-AI transactional queue regression') returning id into w;
 insert into public.threads(workspace_id,name,share_code) values(w,'Queue regression','regression-'||gen_random_uuid()::text) returning id into t;
 insert into public.files(thread_id,path,content) values(t,'source.py','old');
 insert into public.agent_runs(thread_id,prompt) values(t,'regression') returning id into r;
 if not public.begin_agent_run(t,r) then raise exception 'first reservation failed'; end if;
 if public.begin_agent_run(t,r) then raise exception 'duplicate invocation acquired active run'; end if;
 if exists(select 1 from public.claim_agent_run('regression-worker',90,r)) then raise exception 'claimed incomplete proposal'; end if;
 proposal:=public.save_agent_proposal(t,r,'["fix", "test"]','[{"path":"source.py","label":"fix","before":"old","after":"new"}]','python -m unittest','/workspace');
 if proposal->>'queued' <> 'true' then raise exception 'proposal not queued'; end if;
 select * into claimed from public.claim_agent_run('regression-worker',90,r);
 if claimed.run_id is distinct from r then raise exception 'ready proposal was not claimed'; end if;
 d:=(proposal->'diff_ids'->>0)::uuid;
 perform public.renew_worker_lease('regression-worker',r,90);
 perform public.record_executor_evidence('regression-worker',r,d,'python -m unittest',true,'ok',false,'https://sandbox.example/operations/test');
 perform public.finish_worker_run('regression-worker',r,true);
 if not exists(select 1 from public.agent_runs where id=r and state='review' and lease_owner is null) then raise exception 'successful run did not reach review'; end if;
 if not exists(select 1 from public.threads where id=t and status='review') then raise exception 'successful thread did not reach review'; end if;
 -- Same revision in a later run is valid and cannot collide with the old hash index.
 insert into public.agent_runs(thread_id,prompt) values(t,'second run') returning id into r2;
 if not public.begin_agent_run(t,r2) then raise exception 'review blocked the next run'; end if;
 proposal:=public.save_agent_proposal(t,r2,'["fix"]','[{"path":"source.py","label":"fix","before":"old","after":"new"}]','python -m unittest','/workspace');
 perform * from public.claim_agent_run('regression-worker',90,r2);
 perform public.finish_worker_run('regression-worker',r2,false);
 if not exists(select 1 from public.agent_runs where id=r2 and state='blocked') then raise exception 'failed run did not block'; end if;
 -- A wrong before revision must roll the entire proposal back.
 insert into public.agent_runs(thread_id,prompt,state) values(t,'wrong revision','plan') returning id into r2;
 begin
  perform public.save_agent_proposal(t,r2,'["fix"]','[{"path":"source.py","label":"bad","before":"stale","after":"new"}]','python -m unittest','/workspace');
  raise exception 'stale source was accepted';
 exception when sqlstate '22023' then null;
 end;
 if exists(select 1 from public.diffs where run_id=r2) then raise exception 'failed proposal partially persisted'; end if;
end;
$$;
