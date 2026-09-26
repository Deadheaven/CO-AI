"""One bounded worker iteration: claim, stage, execute, and record evidence."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .evidence import evidence_from_result
from .nebius import SandboxError, SandboxResult
from .supabase import ClaimedRun


class Gateway(Protocol):
    def claim(self, worker_id: str, lease_seconds: int = 90) -> ClaimedRun | None: ...
    def append_event(self, worker_id: str, run_id: str, event_type: str, payload: dict[str, object]) -> None: ...
    def record_evidence(self, worker_id: str, run_id: str, diff_id: str, evidence: object) -> None: ...
    def finish(self, worker_id: str, run_id: str, passed: bool) -> None: ...


class Executor(Protocol):
    def run(self, command: str, *, cwd: str, files: dict[str, bytes]) -> SandboxResult: ...


@dataclass(frozen=True)
class RunOutcome:
    run_id: str | None
    state: str


class VerificationWorker:
    def __init__(self, worker_id: str, gateway: Gateway, executor: Executor) -> None:
        self._worker_id, self._gateway, self._executor = worker_id, gateway, executor

    def run_once(self) -> RunOutcome:
        run = self._gateway.claim(self._worker_id)
        if run is None: return RunOutcome(None, "idle")
        if not run.execution_command or not run.diff_ids:
            self._gateway.append_event(self._worker_id, run.run_id, "verification-blocked", {"reason": "missing command or diff"})
            self._gateway.finish(self._worker_id, run.run_id, False)
            return RunOutcome(run.run_id, "blocked")
        self._gateway.append_event(self._worker_id, run.run_id, "verification-started", {"command": run.execution_command, "file_count": len(run.files)})
        try:
            result = self._executor.run(run.execution_command, cwd=run.execution_cwd, files=dict(run.files))
        except (SandboxError, ValueError) as error:
            self._gateway.append_event(self._worker_id, run.run_id, "verification-failed", {"reason": str(error)[:300]})
            self._gateway.finish(self._worker_id, run.run_id, False)
            return RunOutcome(run.run_id, "blocked")
        evidence = evidence_from_result(run.execution_command, result)
        for diff_id in run.diff_ids:
            self._gateway.record_evidence(self._worker_id, run.run_id, diff_id, evidence)
        self._gateway.finish(self._worker_id, run.run_id, evidence.passed)
        return RunOutcome(run.run_id, "review" if evidence.passed else "blocked")
