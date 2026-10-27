"""Long-running, fail-closed CO-AI sandbox verification worker."""

from __future__ import annotations

import os
import socket
import sys
import time
import argparse

from .nebius import NebiusSandboxExecutor, SandboxConfig
from .service import VerificationWorker
from .supabase import SupabaseWorkerConfig, SupabaseWorkerGateway


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate required worker configuration and exit")
    parser.add_argument("--once", action="store_true", help="process exactly one explicitly selected run")
    parser.add_argument("--run-id", help="run UUID to claim; required with --once")
    args = parser.parse_args()
    if args.once and not args.run_id:
        parser.error("--once requires --run-id to avoid claiming another queued run")
    if args.run_id and not args.once:
        parser.error("--run-id can only be used with --once")
    worker_id = os.environ.get("COAI_WORKER_ID", "").strip() or f"coai-{socket.gethostname()}-{os.getpid()}"
    gateway = SupabaseWorkerGateway(SupabaseWorkerConfig(_required("SUPABASE_URL"), _required("SUPABASE_SERVICE_ROLE_KEY")))
    executor = NebiusSandboxExecutor(SandboxConfig(
        base_url=_required("NEBIUS_SANDBOX_BASE_URL"), iam_token=os.environ.get("NEBIUS_API_KEY", "").strip() or _required("NEBIUS_IAM_TOKEN"),
        project_id=_required("NEBIUS_PROJECT_ID"), image=_required("NEBIUS_SANDBOX_IMAGE"),
        timeout_seconds=60 if args.once else 600,
    ))
    worker = VerificationWorker(worker_id, gateway, executor)
    if args.check:
        print("worker configuration is complete")
        return
    if args.once:
        outcome = worker.run_once(args.run_id)
        print(f"run={outcome.run_id or args.run_id} state={outcome.state}")
        if outcome.state in {"idle", "blocked", "lease-lost"}:
            raise SystemExit(1)
        return
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
