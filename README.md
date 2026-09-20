# CO-AI

**A collaborative coding room where a team can inspect how an AI-assisted change became safe to ship.**

CO-AI turns a task into a reviewable decision trail: request, planned patch,
human feedback, execution evidence, revision-bound approvals, and a GitHub PR.
It is built for small engineering teams, not autonomous deployment.

> Status: early hackathon build. Demo mode is available without credentials.
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
```

## Trust model

- Browser clients authenticate with Supabase and can only operate in threads
  where they are members.
- Agent and GitHub handlers require a valid JWT plus membership verification
  before using their service-role database access.
- Human approvals are normalized, transactional records; they bind to an
  immutable patch revision.
- A rejection blocks that revision. Any new revision needs fresh approval.
- Live merges require passing evidence marked as coming from an executor.
- Public replay/export is not implemented yet; do not place secrets in task
  text, repository files, or logs.

## Current limitations

The repository import, isolated sandbox worker, GitHub App installation flow,
and executable test runner are the next required milestones. The present
one-shot agent function can produce a proposal, but intentionally cannot
claim it executed tests. This keeps the product honest while those components
are added.

## Contributing

Open an issue with a reproducible workflow failure, expected behavior, and a
minimal repository fixture where possible. Please do not report secrets in a
public issue.

Licensed under [Apache-2.0](LICENSE).
