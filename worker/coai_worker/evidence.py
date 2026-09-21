"""Convert a completed sandbox command into the only evidence CO-AI trusts."""

from __future__ import annotations

from dataclasses import dataclass

from .nebius import SandboxResult


@dataclass(frozen=True)
class ExecutorEvidence:
    command: str
    passed: bool
    output: str
    truncated: bool
    operation_url: str | None


def evidence_from_result(command: str, result: SandboxResult) -> ExecutorEvidence:
    """Preserve both streams and never turn truncated output into proof."""
    output = f"[stdout]\n{result.stdout}\n[stderr]\n{result.stderr}".strip()
    truncated = result.stdout_truncated or result.stderr_truncated
    return ExecutorEvidence(command, result.passed and not truncated, output, truncated, result.operation_url or None)
