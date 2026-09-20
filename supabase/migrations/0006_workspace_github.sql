-- 0006_workspace_github.sql — CO-AI M3 finishing pass
-- 1) Workspace-level GitHub connection (the "Connect repository" settings UI
--    persists here; coai-gh reads these columns via the service-role key with
--    env fallback). base_branch defaults to main.
alter table public.workspaces
  add column if not exists repo_owner text,
  add column if not exists repo_name  text,
  add column if not exists base_branch text not null default 'main';

-- 2) Workspace settings changes (threshold + repo) must propagate live to
--    every open tab, so publish workspaces to the realtime publication.
alter publication supabase_realtime add table public.workspaces;

-- RLS is unchanged by design: workspace_select_signed_in / workspace_update_signed_in
-- already let members of the team read and update the single shared workspace row.