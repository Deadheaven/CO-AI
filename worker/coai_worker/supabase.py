"""Small REST client for worker-only Supabase queue RPCs."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .evidence import ExecutorEvidence


class QueueError(RuntimeError):
    pass


@dataclass(frozen=True)
class SupabaseWorkerConfig:
    url: str
    service_role_key: str

    def __post_init__(self) -> None:
        if not self.url.startswith("https://") or not self.service_role_key:
            raise ValueError("Supabase HTTPS URL and service-role key are required")


@dataclass(frozen=True)
class ClaimedRun:
    run_id: str
    thread_id: str
    prompt: str
    execution_command: str | None
    execution_cwd: str
    base_sha: str | None
    attempt: int


class SupabaseWorkerGateway:
    def __init__(self, config: SupabaseWorkerConfig, *, opener: Callable[..., Any] = urlopen) -> None:
        self._config = config
        self._open = opener

    def claim(self, worker_id: str, lease_seconds: int = 90) -> ClaimedRun | None:
        rows = self._rpc("claim_agent_run", {"p_worker_id": worker_id, "p_lease_seconds": lease_seconds})
        if not rows: return None
        if len(rows) != 1: raise QueueError("claim RPC returned more than one run")
        row = rows[0]
        return ClaimedRun(_required(row, "run_id"), _required(row, "thread_id"), _required(row, "prompt"),
          _optional(row, "execution_command"), _optional(row, "execution_cwd") or "/workspace", _optional(row, "base_sha"), int(row.get("attempt", 0)))

    def append_event(self, worker_id: str, run_id: str, event_type: str, payload: Mapping[str, Any]) -> None:
        self._rpc("append_worker_event", {"p_worker_id": worker_id, "p_run": run_id, "p_event_type": event_type, "p_payload": payload})

    def record_evidence(self, worker_id: str, run_id: str, diff_id: str, evidence: ExecutorEvidence) -> None:
        self._rpc("record_executor_evidence", {"p_worker_id": worker_id, "p_run": run_id, "p_diff": diff_id,
          "p_command": evidence.command, "p_passed": evidence.passed, "p_output": evidence.output,
          "p_truncated": evidence.truncated, "p_operation_url": evidence.operation_url})

    def _rpc(self, name: str, payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
        request = Request(self._config.url.rstrip("/") + "/rest/v1/rpc/" + name, data=json.dumps(payload).encode(), method="POST",
          headers={"apikey": self._config.service_role_key, "Authorization": f"Bearer {self._config.service_role_key}", "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with self._open(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8") or "[]")
        except HTTPError as error:
            raise QueueError(f"Supabase RPC {name} failed with HTTP {error.code}") from error
        except (URLError, json.JSONDecodeError) as error:
            raise QueueError(f"Supabase RPC {name} failed") from error
        if not isinstance(data, list) or not all(isinstance(item, Mapping) for item in data):
            raise QueueError(f"Supabase RPC {name} returned an invalid payload")
        return data


def _required(row: Mapping[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value: raise QueueError(f"claimed run omitted {key}")
    return value


def _optional(row: Mapping[str, Any], key: str) -> str | None:
    value = row.get(key)
    return value if isinstance(value, str) and value else None
