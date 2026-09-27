-- 0009_workspace_verification_config.sql
-- An owner-configured command is the explicit contract the sandbox executes.

alter table public.workspaces
  add column if not exists verification_command text,
  add column if not exists verification_cwd text not null default '/workspace';

alter table public.workspaces
  add constraint workspaces_verification_cwd_absolute
  check (verification_cwd ~ '^/([^/]+/)*[^/]*$' or verification_cwd = '/workspace') not valid;
