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
    diff_ids: tuple[str, ...]
    files: Mapping[str, bytes]


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
          _optional(row, "execution_command"), _optional(row, "execution_cwd") or "/workspace", _optional(row, "base_sha"), int(row.get("attempt", 0)),
          _diff_ids(row), _patched_files(row))

    def append_event(self, worker_id: str, run_id: str, event_type: str, payload: Mapping[str, Any]) -> None:
        self._rpc("append_worker_event", {"p_worker_id": worker_id, "p_run": run_id, "p_event_type": event_type, "p_payload": payload})

    def record_evidence(self, worker_id: str, run_id: str, diff_id: str, evidence: ExecutorEvidence) -> None:
        self._rpc("record_executor_evidence", {"p_worker_id": worker_id, "p_run": run_id, "p_diff": diff_id,
          "p_command": evidence.command, "p_passed": evidence.passed, "p_output": evidence.output,
          "p_truncated": evidence.truncated, "p_operation_url": evidence.operation_url})

    def finish(self, worker_id: str, run_id: str, passed: bool) -> None:
        self._rpc("finish_worker_run", {"p_worker_id": worker_id, "p_run": run_id, "p_passed": passed})

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


def _diff_ids(row: Mapping[str, Any]) -> tuple[str, ...]:
    raw = row.get("diff_ids", [])
    if not isinstance(raw, list) or not all(isinstance(value, str) and value for value in raw):
        raise QueueError("claimed run has invalid diff ids")
    return tuple(raw)


def _files(row: Mapping[str, Any]) -> Mapping[str, bytes]:
    raw = row.get("files", [])
    if not isinstance(raw, list): raise QueueError("claimed run has invalid files")
    out: dict[str, bytes] = {}
    for item in raw:
        if not isinstance(item, Mapping): raise QueueError("claimed run has invalid file entry")
        path, content = item.get("path"), item.get("content")
        if not isinstance(path, str) or not path or path.startswith("/") or "\x00" in path or any(part in {"", ".", ".."} for part in path.split("/")):
            raise QueueError("claimed run has unsafe repository path")
        if not isinstance(content, str): raise QueueError("claimed run has non-text file content")
        out["/workspace/" + path] = content.encode("utf-8")
    return out

def _patched_files(row: Mapping[str, Any]) -> Mapping[str, bytes]:
    out = dict(_files(row))
    patches = row.get("patches", [])
    if not isinstance(patches, list): raise QueueError("claimed run has invalid patches")
    for patch in patches:
        if not isinstance(patch, Mapping): raise QueueError("claimed run has invalid patch")
        path, content = patch.get("path"), patch.get("after")
        if not isinstance(path, str) or not path or path.startswith("/") or "\x00" in path or any(part in {"", ".", ".."} for part in path.split("/")):
            raise QueueError("claimed run has unsafe patch path")
        if not isinstance(content, str): raise QueueError("claimed run has non-text patch content")
        out["/workspace/" + path] = content.encode("utf-8")
    return out
