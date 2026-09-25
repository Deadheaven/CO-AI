# CO-AI sandbox worker

This package owns isolated execution only. It deliberately has **no local
subprocess fallback**: a hosted run without a configured sandbox must fail,
not execute untrusted repository code on the worker host.

`coai_worker.nebius.NebiusSandboxExecutor` implements the documented Nebius
Token Factory Sandbox `POST /instances` lifecycle. It creates a disposable,
network-disabled instance and treats output as execution evidence only after a
terminal result is returned.

Required configuration for the queue worker:

- sandbox base URL
- Nebius IAM token
- Nebius Project ID
- immutable image UUID or approved image tag

The worker stages each exact repository file through Nebius' content upload
endpoint, verifies the returned SHA-256 and byte count, and mounts the returned
file IDs at allowlisted absolute paths. It uses service-role-only RPCs from migration `0008` to atomically
claim a run, append an ordered event, and attach evidence to the exact diff.
It does not accept a browser-supplied evidence payload.

`VerificationWorker.run_once()` is the bounded integration point: it leases a
run, mounts its persisted files, executes one configured command, writes the
same evidence to every current diff, then transitions the run to review or
blocked. It does not execute when the command or revision set is missing.

Run its dependency-free contract tests:

```bash
PYTHONPATH=worker python -m unittest discover -s worker/tests -v
```

## Run the worker

For a Docker host, create a private worker environment file from the template:

```bash
cp worker/.env.worker.example worker/.env.worker
# Fill worker/.env.worker using a local editor or the host's secret manager.
docker compose --env-file worker/.env.worker -f compose.worker.yaml up -d --build
docker compose --env-file worker/.env.worker -f compose.worker.yaml logs -f coai-worker
```

The service restarts automatically, runs without Linux capabilities or a
writable container filesystem, and exposes no inbound port. The populated
environment file is ignored by git and excluded from the Docker build context.
Keep these credentials in the worker host's secret manager for hosted
deployments; never put the service-role or Nebius keys in browser configuration.
