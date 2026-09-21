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

Run its dependency-free contract tests:

```bash
PYTHONPATH=worker python -m unittest discover -s worker/tests -v
```

The queue-claiming service and repository staging are intentionally separate
from this adapter. They must supply an exact revision, an allowlisted command,
and a persistent evidence writer.
