-- 0002_harden_search_path.sql — pin search_path on every function involved in RLS
-- so it cannot be hijacked via a malicious search_path when invoked in an RLS
-- context. Matches the state already applied to the live project.
alter function public.is_thread_member(uuid) set search_path = public;
alter function public.thread_workspace_member(uuid) set search_path = public;
alter function public.touch_thread() set search_path = public;