
do $$
declare w uuid; t uuid; r uuid; m uuid; n int;
begin
 select id into m from public.members where display_name='Acceptance reviewer 1' limit 1;
 if m is null then raise exception 'acceptance identity missing'; end if;
 perform set_config('request.jwt.claim.sub',m::text,true);
 insert into public.workspaces(name) values('CO-AI expiry regression') returning id into w;
 insert into public.threads(workspace_id,name,share_code) values(w,'Expiry regression','expiry-'||gen_random_uuid()::text) returning id into t;
 insert into public.thread_members(thread_id,member_id) values(t,m);
 insert into public.agent_runs(thread_id,prompt,state,started_at) values(t,'abandoned proposal','plan',(extract(epoch from now()-interval '10 minutes')*1000)::bigint) returning id into r;
 n:=public.expire_stale_verification_runs();
 if n<1 or not exists(select 1 from public.agent_runs where id=r and state='blocked') then raise exception 'abandoned proposal did not expire'; end if;
 if not exists(select 1 from public.messages where run_id=r::text and meta='blocked') then raise exception 'expiry message missing'; end if;
 if not exists(select 1 from public.threads where id=t and status='blocked') then raise exception 'expired thread did not block'; end if;
end;
$$;
