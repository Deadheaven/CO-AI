# CO-AI

**A collaborative coding room where a team can inspect how an AI-assisted change became safe to ship.**

CO-AI turns a task into a reviewable decision trail: request, planned patch,
human feedback, execution evidence, revision-bound approvals, and a GitHub PR.
It is built for small engineering teams, not autonomous deployment.

> Status: hosted submission in progress. The Sites frontend and Supabase
> backend are active. One live Nemotron proposal and queue-backed passing
> Sandbox run are verified; the patch is awaiting human review. The current
> worker is local; the failing-run, live-review, video, and submission gates
> are tracked in [deploy/SUBMISSION_STATUS.md](deploy/SUBMISSION_STATUS.md).
> The approval gate requires executor-backed evidence for the exact revision.

## Run locally

```bash
npm install
npm run dev
```

Without environment variables, local development runs its visibly labelled
offline demo. Production builds fail closed when the live backend is
unavailable; they never present simulated state as a live service.

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

Add the `nebius` API-key secret and `COAI_LLM_PROVIDER` with value `nebius` in
the Supabase project’s Edge Function secrets. The legacy `NEBIUS_API_KEY` name
is also accepted. Optionally add `NEBIUS_MODEL_ID` with an exact ID
returned by the Token Factory `/v1/models` endpoint. Add the current GitHub
connector credential as `GITHUB_PAT`. Then deploy the function:

```bash
supabase functions deploy coai-agent
```

## Nebius demo deployment

The static frontend can stay on Sites while Supabase hosts auth and data. The
worker can run separately. Do not create a paid VM unless its cost is covered
by verified AI Cloud credits; the standard hackathon Token Factory credit is
for inference, not VM hosting. See
[deploy/NEBIUS.md](deploy/NEBIUS.md) for VM setup, secret placement, either
deployment mode, smoke-test, and teardown instructions.

## Development checks

```bash
npm test
npm run typecheck
npm run build
npm run preflight
```

`npm run preflight -- --live` additionally checks browser and worker config and
reads linked Supabase migration, active-function, and required-secret **names**
status. A Sites static-host manifest removes the combined-VM `COAI_DOMAIN`
requirement. The check never prints secret values, requires Supabase CLI
authentication, and does not deploy or modify remote state.

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

The public demo is a synthetic Python fixture in a dedicated `public_demo`
workspace. Set `VITE_COAI_PUBLIC_DEMO=true` in the static build and
`COAI_PUBLIC_DEMO=true` in Supabase Edge Function secrets to enable guided
controls, block GitHub actions, and enforce server-side run caps. Apply
migration `0011_public_demo_guards.sql` before building or opening that mode.
It caps runs at two per anonymous identity and ten total per UTC day, limits
prompts to 1,000 characters, and limits generated output to 2,048 tokens. This
is a request cap, not a monetary budget meter.

Migrations `0011`–`0016` and the updated Edge Functions are deployed. One live
Nemotron proposal has passed the configured tests in a disposable Sandbox. The
`payments.py` diff remains pending human review. The current worker runs locally
and is not an always-on judging host. A deliberately failing Sandbox run,
live reviewer approvals, a monetary usage limit, and full judge-flow browser
acceptance remain open. The active Site is public. Replay export excludes
repository contents and raw executor output.

## Contributing

Open an issue with a reproducible workflow failure, expected behavior, and a
minimal repository fixture where possible. Please do not report secrets in a
public issue.

Licensed under [Apache-2.0](LICENSE).
