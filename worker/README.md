# CO-AI sandbox worker

This package owns isolated execution only. It deliberately has **no local
subprocess fallback**: a hosted run without a configured sandbox must fail,
not execute untrusted repository code on the worker host.

`coai_worker.nebius.NebiusSandboxExecutor` implements the documented Nebius
Token Factory Sandbox `POST /instances` lifecycle. It creates a disposable,
network-disabled instance and treats output as execution evidence only after a
terminal result is returned.

Required configuration when it is wired into the run queue:

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

Keep these values in the worker host or secret manager, never in browser environment variables:

```bash
export SUPABASE_URL=https://your-project.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...
export NEBIUS_SANDBOX_BASE_URL=https://...
export NEBIUS_IAM_TOKEN=...
export NEBIUS_PROJECT_ID=...
export NEBIUS_SANDBOX_IMAGE=...
PYTHONPATH=worker python -m coai_worker.main
```

The queue-claiming service and repository staging are intentionally separate
from this adapter. They must supply an exact revision, an allowlisted command,
and a persistent evidence writer.
