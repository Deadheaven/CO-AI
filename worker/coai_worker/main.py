"""Long-running, fail-closed CO-AI sandbox verification worker."""

from __future__ import annotations

import os
import socket
import sys
import time

from .nebius import NebiusSandboxExecutor, SandboxConfig
from .service import VerificationWorker
from .supabase import SupabaseWorkerConfig, SupabaseWorkerGateway


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> None:
    worker_id = os.environ.get("COAI_WORKER_ID", "").strip() or f"coai-{socket.gethostname()}-{os.getpid()}"
    gateway = SupabaseWorkerGateway(SupabaseWorkerConfig(_required("SUPABASE_URL"), _required("SUPABASE_SERVICE_ROLE_KEY")))
    executor = NebiusSandboxExecutor(SandboxConfig(
        base_url=_required("NEBIUS_SANDBOX_BASE_URL"), iam_token=_required("NEBIUS_IAM_TOKEN"),
        project_id=_required("NEBIUS_PROJECT_ID"), image=_required("NEBIUS_SANDBOX_IMAGE"),
    ))
    worker = VerificationWorker(worker_id, gateway, executor)
    while True:
        try:
            outcome = worker.run_once()
        except Exception as error:
            print(f"verification worker iteration failed: {type(error).__name__}", file=sys.stderr, flush=True)
            time.sleep(5)
            continue
        if outcome.state == "idle": time.sleep(2)


if __name__ == "__main__":
    main()
