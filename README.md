# CO-AI

**A collaborative coding room where a team can inspect how an AI-assisted change became safe to ship.**

CO-AI turns a task into a reviewable decision trail: request, planned patch,
human feedback, execution evidence, revision-bound approvals, and a GitHub PR.
It is built for small engineering teams, not autonomous deployment.

> Status: early hackathon build. The Supabase schema and Edge Functions are deployed;
> demo mode remains available without credentials.
> The hosted approval gate intentionally rejects model-authored test output;
> executor-backed evidence is required before a live merge can unlock.

## Run locally

```bash
npm install
npm run dev
```

Without environment variables, CO-AI runs its visibly labelled local demo.

To connect a Supabase project, copy `.env.example` to `.env.local`, fill in
the **publishable** project URL and anonymous key, and apply migrations in
order:

```bash
supabase db push
supabase functions deploy coai-agent
supabase functions deploy coai-gh
supabase functions deploy coai-replay
```

The edge functions need `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from
their runtime environment. Configure model and GitHub credentials as Supabase
function secrets, never as `VITE_` variables.

```bash
supabase secrets set NVIDIA_API_KEY=...  # or LLM_API_KEY
# Current GitHub connector compatibility path:
supabase secrets set GITHUB_PAT=...
```

## Development checks

```bash
npm test
npm run typecheck
npm run build
npm run preflight
```

`npm run preflight -- --live` additionally checks for populated browser and
worker config files and reads linked Supabase migration, active-function, and
required-secret **names** status. It never prints secret values. The live check
requires Supabase CLI authentication and does not deploy or modify remote state.

## Trust model

- Browser clients authenticate with Supabase and can only operate in threads
  where they are members.
- Agent and GitHub handlers require a valid JWT plus membership verification
  before using their service-role database access.
- Human approvals are normalized, transactional records; they bind to an
  immutable patch revision.
- A rejection blocks that revision. Any new revision needs fresh approval.
- Live merges require passing evidence marked as coming from an executor.
- Replay export is authenticated and intentionally excludes repository contents
  and raw executor output. Do not place secrets in task text, repository files,
  or logs.

## Current limitations

Repository import, isolated verification, and replay export are deployed. The
remaining launch gates are browser configuration, Nebius and worker-host
credentials, deploying the always-on worker (a Docker Compose configuration is
provided), a live two-user smoke test, and the GitHub App installation flow.
NVIDIA Nemotron and the GitHub PAT compatibility path are configured as
Supabase Function secrets. Replay export excludes repository contents and raw
executor output.

## Contributing

Open an issue with a reproducible workflow failure, expected behavior, and a
minimal repository fixture where possible. Please do not report secrets in a
public issue.

Licensed under [Apache-2.0](LICENSE).
