# CO-AI

**A collaborative coding room where a team can inspect how an AI-assisted change became safe to ship.**

CO-AI turns a task into a reviewable decision trail: request, planned patch,
human feedback, execution evidence, revision-bound approvals, and a GitHub PR.
It is built for small engineering teams, not autonomous deployment.

> Status: early hackathon build. The Nebius-hosted demo path is prepared; it needs
> project credentials and a live sandbox smoke test before it is judge-ready.
> Demo mode remains available without credentials.
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
function secrets, never as `VITE_` variables. The hackathon route uses Nemotron
through Nebius Token Factory; it selects a live catalog model or validates the
configured Nemotron ID before making a request.

Add `NEBIUS_API_KEY` and `COAI_LLM_PROVIDER=nebius` in the Supabase project’s
Edge Function secrets. Optionally add `NEBIUS_MODEL_ID` with an exact ID
returned by the Token Factory `/v1/models` endpoint. Add the current GitHub
connector credential as `GITHUB_PAT`. Then deploy the function:

```bash
supabase functions deploy coai-agent
```

## Nebius demo deployment

The demo can serve the built web app and run the queue worker on one Nebius AI
Cloud VM. Caddy provides HTTPS for a domain pointed at that VM. The worker
connects to Nebius Token Factory Sandboxes, and the Supabase Edge Function calls
Nemotron through Token Factory. See [deploy/NEBIUS.md](deploy/NEBIUS.md) for VM
setup, secret placement, deploy, smoke-test, and teardown instructions.

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

Repository import, isolated verification, and replay export are implemented.
The Nebius demo deployment configuration is provided, but deployment, live
Token Factory inference, sandbox execution, and the two-user smoke test still
require configured accounts and credentials. The current GitHub PAT path is
available; a GitHub App installation flow is not part of the hackathon demo
critical path. Replay export excludes repository contents and raw executor
output.

## Contributing

Open an issue with a reproducible workflow failure, expected behavior, and a
minimal repository fixture where possible. Please do not report secrets in a
public issue.

Licensed under [Apache-2.0](LICENSE).
