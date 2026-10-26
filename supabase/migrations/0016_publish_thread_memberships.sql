-- New collaborators and workspace policy changes must reach existing sessions.
do $$ begin
  alter publication supabase_realtime add table public.thread_members;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.workspaces;
exception when duplicate_object then null;
end $$;
