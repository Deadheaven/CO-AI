# Nebius hosted demo

This deployment serves the Vite frontend over HTTPS and runs the isolated
queue worker on one Nebius AI Cloud CPU VM. Supabase remains the auth and data
backend; model inference goes to Nemotron on Token Factory, and repository
commands run in Token Factory Sandboxes.

## 1. Prepare Nebius and DNS

1. Create a Nebius AI Cloud project and a small CPU VM with a public IPv4
   address. The app itself does not need a GPU: inference is through Token
   Factory. Follow the [Nebius Compute quickstart](https://docs.nebius.com/compute/quickstart).
2. Point a DNS `A` record for the demo hostname at the VM's public IPv4. Open
   inbound TCP ports 80 and 443. Restrict SSH (TCP 22) to your own IP.
3. Install Docker Engine with the Compose plugin on the VM. Create a deploy
   account that can run Docker and write to `/opt/co-ai`.
4. In Token Factory, create an API key for inference. Separately configure
   Token Factory Sandboxes access and select an approved sandbox image. The
   worker requires an IAM bearer token and the Nebius Project ID for the
   sandbox service; these are distinct from the Token Factory inference key.
5. In Supabase Auth settings, enable anonymous sign-ins. CO-AI creates an
   anonymous identity per browser session; verify that two separate sessions
   can join the demo thread.

## 2. Configure Supabase and the VM

In the Supabase Dashboard's Edge Function secrets, add `NEBIUS_API_KEY` and
`COAI_LLM_PROVIDER` with value `nebius`. Optionally add `NEBIUS_MODEL_ID` with
an exact ID returned by Token Factory's `/v1/models` endpoint. The model API
key belongs here; it is separate from the sandbox IAM token. Then, from a
trusted local shell with the Supabase CLI linked to the project, deploy the
function:

```bash
supabase functions deploy coai-agent
```

Do not put secret values in shell history, this repository, or the browser
environment. The function checks Token Factory's model catalog and refuses
to substitute another model family.

On the VM, create `/opt/co-ai/.env.nebius` from `.env.nebius.example` and
`/opt/co-ai/worker/.env.worker` from `worker/.env.worker.example`. Fill in the
public Supabase URL and publishable anon key in `.env.nebius`. In
`worker/.env.worker`, configure the Supabase URL and service-role key, the
Sandbox API base URL, IAM token, Project ID, and approved image. Set the files
to mode `0600` and ensure the deploy account owns them. Never use the service
role key or either Nebius secret as a `VITE_` value.

## 3. Deploy and update

With SSH access and the two configured environment files already present on
the VM, run from the repository root:

```bash
bash deploy/nebius-deploy.sh deploy-user@VM_PUBLIC_IP
```

The script transfers the source while excluding `.git`, local env files,
generated files, and Supabase temporary state, then builds and starts the
frontend and worker. Caddy obtains and renews HTTPS certificates for
`COAI_DOMAIN`; DNS must already resolve to this VM and ports 80/443 must be
reachable.

Check service state and logs on the VM:

```bash
cd /opt/co-ai
docker compose --env-file .env.nebius --env-file worker/.env.worker \
  -f compose.worker.yaml ps
docker compose --env-file .env.nebius --env-file worker/.env.worker \
  -f compose.worker.yaml logs --tail=100 coai-web coai-worker
```

The public demo URL is `https://` followed by `COAI_DOMAIN`.

## 4. Live acceptance check

1. Open the public URL in two separate browser sessions and join the same
   thread as two users.
2. Import a small, owned fixture repository with a known passing test command.
3. Ask the agent for one bounded change. Confirm the model run succeeds and
   the selected model ID is a Nemotron ID from the Token Factory catalog.
4. Confirm the worker claims the queued run, stages the exact repository files
   in a disposable sandbox, and returns a successful test result attached to
   that revision.
5. Repeat with a deliberately failing test and confirm the diff stays blocked
   from approval/merge. Check replay, approvals, and fresh-page reload.
6. Record sanitized evidence: UTC time, model ID, sandbox operation reference,
   test command and outcome, demo URL, and deployment revision. Never include
   API keys, IAM tokens, service-role keys, or repository secrets.

Keep the VM, domain, Supabase project, and test access available through the
end of judging. Remove the VM and its public IP after judging if the demo is no
longer needed; preserve only the evidence and artifacts required for the
submission.
