"""Minimal, auditable Nebius Token Factory Sandbox REST adapter.

The adapter uses only the documented ``POST /instances`` lifecycle: create a
disposable VM-backed instance, then poll the operation URL supplied in the
``Location`` response header. It never executes a repository command locally.
"""

from __future__ import annotations

import base64
import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class SandboxError(RuntimeError):
    """A provider response that cannot be treated as execution evidence."""


@dataclass(frozen=True)
class SandboxConfig:
    base_url: str
    iam_token: str
    project_id: str
    image: str
    timeout_seconds: int = 600
    output_limit_bytes: int = 65_536
    poll_interval_seconds: float = 2.0

    def __post_init__(self) -> None:
        if not self.base_url.startswith("https://"):
            raise ValueError("base_url must use HTTPS")
        if not self.iam_token or not self.project_id or not self.image:
            raise ValueError("IAM token, project id, and image are required")
        if not 1 <= self.timeout_seconds <= 600:
            raise ValueError("timeout_seconds must be between 1 and 600")
        if not 1 <= self.output_limit_bytes <= 10 * 1024 * 1024:
            raise ValueError("output_limit_bytes must be between 1 and 10485760")


@dataclass(frozen=True)
class SandboxResult:
    operation_url: str
    exit_code: int | None
    timed_out: bool
    stdout: str
    stderr: str
    stdout_truncated: bool
    stderr_truncated: bool
    raw: Mapping[str, Any]

    @property
    def passed(self) -> bool:
        return self.exit_code == 0 and not self.timed_out


Opener = Callable[..., Any]
Sleeper = Callable[[float], None]
Clock = Callable[[], float]


class NebiusSandboxExecutor:
    """Run one explicit command in a disposable, network-isolated sandbox."""

    def __init__(
        self,
        config: SandboxConfig,
        *,
        opener: Opener = urlopen,
        sleeper: Sleeper = time.sleep,
        clock: Clock = time.monotonic,
    ) -> None:
        self._config = config
        self._open = opener
        self._sleep = sleeper
        self._clock = clock

    def run(self, command: str, *, cwd: str = "/workspace") -> SandboxResult:
        if not command.strip():
            raise ValueError("command is required")
        if not cwd.startswith("/"):
            raise ValueError("cwd must be absolute")

        payload = {
            "command": command,
            "image": self._config.image,
            "shell": True,
            "cwd": cwd,
            "timeout": self._config.timeout_seconds,
            "truncate_output_at": self._config.output_limit_bytes,
            "disposable": True,
            "networking": {"enabled": False},
        }
        response, body = self._request("POST", "/instances", payload)
        location = response.get("Location") or response.get("location")
        if not location:
            # A terminal response is acceptable only when it includes complete
            # execution result. Otherwise guessing an operation URL is unsafe.
            if isinstance(body.get("result"), Mapping):
                return self._result("", body)
            raise SandboxError("sandbox response omitted operation Location")
        operation_url = self._absolute_location(str(location))
        if isinstance(body.get("result"), Mapping):
            return self._result(operation_url, body)
        return self._poll(operation_url)

    def _poll(self, operation_url: str) -> SandboxResult:
        deadline = self._clock() + self._config.timeout_seconds + 30
        while self._clock() < deadline:
            _, body = self._request("GET", operation_url)
            if isinstance(body.get("result"), Mapping):
                return self._result(operation_url, body)
            self._sleep(self._config.poll_interval_seconds)
        raise SandboxError("sandbox operation did not produce a result before worker deadline")

    def _request(self, method: str, path_or_url: str, payload: Mapping[str, Any] | None = None) -> tuple[Mapping[str, str], Mapping[str, Any]]:
        url = path_or_url if path_or_url.startswith("https://") else self._config.base_url.rstrip("/") + path_or_url
        data = json.dumps(payload).encode() if payload is not None else None
        request = Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self._config.iam_token}",
                "Project": self._config.project_id,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with self._open(request, timeout=self._config.timeout_seconds) as response:
                raw = response.read().decode("utf-8")
                try:
                    body = json.loads(raw) if raw else {}
                except json.JSONDecodeError as error:
                    raise SandboxError("sandbox returned non-JSON response") from error
                if not isinstance(body, Mapping):
                    raise SandboxError("sandbox returned a non-object JSON response")
                return dict(response.headers.items()), body
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise SandboxError(f"sandbox HTTP {error.code}: {detail}") from error
        except URLError as error:
            raise SandboxError(f"sandbox network error: {error.reason}") from error

    def _absolute_location(self, location: str) -> str:
        if location.startswith("https://"):
            return location
        if not location.startswith("/"):
            raise SandboxError("sandbox Location must be an absolute URL or path")
        return self._config.base_url.rstrip("/") + location

    @staticmethod
    def _result(operation_url: str, body: Mapping[str, Any]) -> SandboxResult:
        result = body.get("result")
        if not isinstance(result, Mapping):
            raise SandboxError("terminal sandbox operation omitted result")
        state = result.get("state") if isinstance(result.get("state"), Mapping) else {}
        stdout = result.get("stdout") if isinstance(result.get("stdout"), Mapping) else {}
        stderr = result.get("stderr") if isinstance(result.get("stderr"), Mapping) else {}
        return SandboxResult(
            operation_url=operation_url,
            exit_code=_as_int(state.get("exit_code")),
            timed_out=bool(state.get("timed_out", False)),
            stdout=_decode_stream(stdout),
            stderr=_decode_stream(stderr),
            stdout_truncated=bool(stdout.get("truncated", False)),
            stderr_truncated=bool(stderr.get("truncated", False)),
            raw=body,
        )


def _as_int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _decode_stream(stream: Mapping[str, Any]) -> str:
    value = stream.get("value", "")
    if not isinstance(value, str):
        return ""
    if stream.get("encoding") == "base64":
        try:
            return base64.b64decode(value, validate=True).decode("utf-8", errors="replace")
        except ValueError as error:
            raise SandboxError("sandbox stream was invalid base64") from error
    return value
