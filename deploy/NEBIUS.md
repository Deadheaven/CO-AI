# Nebius hosted demo

The frontend can stay on the existing Sites host, Supabase remains the auth
and data backend, model inference goes to Nemotron on Token Factory, and
repository commands run in Token Factory Sandboxes. A Nebius AI Cloud VM is
optional. Standard hackathon credits cover Token Factory inference; verify
separate AI Cloud credits before provisioning a VM to stay within the
credits-only budget.

## 1. Prepare Nebius and DNS

1. Create a Nebius AI Cloud project and a small CPU VM with a public IPv4
   address. The app itself does not need a GPU: inference is through Token
   Factory. Follow the [Nebius Compute quickstart](https://docs.nebius.com/compute/quickstart).
2. Point a DNS `A` record for the demo hostname at the VM's public IPv4. Open
   inbound TCP ports 80 and 443. Restrict SSH (TCP 22) to your own IP.
3. Install Docker Engine with the Compose plugin on the VM. Create a deploy
   account that can run Docker and write to `/opt/co-ai`.
4. In Token Factory, create an API key in the project that will run Sandboxes.
   Activate Sandboxes for that project and caller, then select an approved
   image. The worker accepts `NEBIUS_API_KEY` and needs the Token Factory
   Project ID. An inference key alone does not establish Sandbox permission.
   See the current [access setup](https://docs.tokenfactory.nebius.com/sandboxes/start/set-up-access).
5. In Supabase Auth settings, enable anonymous sign-ins. CO-AI creates an
   anonymous identity per browser session; verify that two separate sessions
   can use the guided fixture thread.

## 2. Configure Supabase and the VM

In the Supabase Dashboard's Edge Function secrets, add `nebius` with the
Token Factory inference API key, and add `COAI_LLM_PROVIDER` with value
`nebius`. The legacy secret name `NEBIUS_API_KEY` is also accepted. Optionally
add `NEBIUS_MODEL_ID` with an exact ID returned by Token Factory's `/v1/models`
endpoint. The model API key belongs here; it is separate from the sandbox IAM
token. Then, from a trusted local shell with the Supabase CLI linked to the
project, deploy the function:

```bash
supabase functions deploy coai-agent
```

Do not put secret values in shell history, this repository, or the browser
environment. The function checks Token Factory's model catalog and refuses
to substitute another model family.

For the judge-facing fixture, apply migrations including
`0011_public_demo_guards.sql`, set the Edge Function secret
`COAI_PUBLIC_DEMO=true`, and set `VITE_COAI_PUBLIC_DEMO=true` in the static
frontend build. Migration 0011 creates a dedicated synthetic payment fixture,
locks its workspace settings to the deployment owner, and enables authenticated
visitors to collaborate on that one public workspace. The Edge Function allows
two runs per anonymous identity and ten total per UTC day, rejects prompts over
1,000 characters, and limits generated output to 2,048 tokens. The cap is a
request-count guard, not a provider billing meter. Public mode disables all
GitHub connector actions and hides repository import, settings, thread
creation, joining, and merge controls.

On the VM, create `/opt/co-ai/worker/.env.worker` from
`worker/.env.worker.example`. Configure the Supabase URL and service-role key,
the Sandbox API base URL, Sandbox-enabled API key, Project ID, and approved image. Keep it
mode `0600` and ensure the deploy account owns it. Never place the service-role
key or Nebius secrets in browser configuration.

Only for the combined frontend-plus-worker deployment, also create
`/opt/co-ai/.env.nebius` with the public Supabase URL, publishable anon key,
and `COAI_DOMAIN`. No custom domain or `.env.nebius` file is needed when the
frontend is hosted separately.

## 3. Deploy and update

For the combined VM deployment, with both configured environment files on the
VM, run from the repository root:

```bash
bash deploy/nebius-deploy.sh deploy-user@VM_PUBLIC_IP
```

The script transfers the source while excluding `.git`, local env files,
generated files, and Supabase temporary state, then builds and starts the
frontend and worker. Caddy obtains and renews HTTPS certificates for
`COAI_DOMAIN`; DNS must already resolve to this VM and ports 80/443 must be
reachable.

For a separately hosted frontend, deploy only the worker. Place the private
`worker/.env.worker` on the VM, then run:

```bash
bash deploy/nebius-deploy.sh deploy-user@VM_PUBLIC_IP worker-only
```

This mode transfers the same secret-free source archive, forces the worker
environment file to mode `0600`, and starts only the isolated queue worker.
It exposes no inbound port and does not require Caddy, a public DNS record, or
frontend environment variables.

Check service state and logs on the VM:

```bash
cd /opt/co-ai
docker compose --env-file .env.nebius --env-file worker/.env.worker \
  -f compose.worker.yaml ps
docker compose --env-file .env.nebius --env-file worker/.env.worker \
  -f compose.worker.yaml logs --tail=100 coai-web coai-worker
```

For worker-only mode, use:

```bash
docker compose --env-file worker/.env.worker -f compose.worker-only.yaml ps
docker compose --env-file worker/.env.worker -f compose.worker-only.yaml logs --tail=100 coai-worker
```

The public demo URL is `https://` followed by `COAI_DOMAIN`.

## 4. Live acceptance check

1. Select an approved sandbox image that includes Python 3. Run the preflight,
   then open the deployed frontend URL in two separate browser sessions and confirm
   both can see the `DEMO-COAI` fixture. A Sites URL remains subject to its
   configured audience; enable public judge access only after the backend is
   ready.
2. Ask the agent for one bounded idempotency change. Confirm the model run succeeds and
   the selected model ID is a Nemotron ID from the Token Factory catalog.
4. Confirm the worker claims the queued run, stages the exact repository files
   in a disposable sandbox, and returns a successful test result attached to
   that revision.
5. Repeat with a deliberately failing fixture test and confirm the diff remains
   visibly unverified or fails review. Check replay, approvals, and fresh-page
   reload. GitHub import and merge are deliberately disabled in public mode.
6. Record sanitized evidence: UTC time, model ID, sandbox operation reference,
   test command and outcome, demo URL, and deployment revision. Never include
   API keys, IAM tokens, service-role keys, or repository secrets.

Keep the VM, domain, Supabase project, and test access available through the
end of judging. Remove the VM and its public IP after judging if the demo is no
longer needed; preserve only the evidence and artifacts required for the
submission.
