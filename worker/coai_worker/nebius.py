"""Minimal, auditable Nebius Token Factory Sandbox REST adapter.

The adapter uses only the documented ``POST /instances`` lifecycle: create a
disposable VM-backed instance, then poll the operation URL supplied in the
``Location`` response header. It never executes a repository command locally.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit, urljoin
from uuid import UUID
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
    signal: int | str | None = None

    @property
    def passed(self) -> bool:
        return self.exit_code == 0 and not self.timed_out and self.signal in (None, 0, "")


@dataclass(frozen=True)
class UploadedFile:
    uuid: str
    sha256: str
    size: int


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

    def run(self, command: str, *, cwd: str = "/workspace", files: Mapping[str, bytes] | None = None) -> SandboxResult:
        if not command.strip():
            raise ValueError("command is required")
        if not cwd.startswith("/"):
            raise ValueError("cwd must be absolute")

        staged = self.stage_files(files or {})
        payload = {
            "command": command,
            "image": self._config.image,
            "shell": True,
            "cwd": cwd,
            "timeout": self._config.timeout_seconds,
            "truncate_output_at": self._config.output_limit_bytes,
            "disposable": True,
            "networking": {"enabled": False},
            "files": staged,
        }
        response, body = self._request("POST", "/instances", payload)
        if body.get("status") in {"FAILED", "CANCELLED"}:
            raise SandboxError(f"sandbox operation ended with status {body['status']}")
        location = response.get("Location") or response.get("location")
        if not location:
            # A terminal response is acceptable only when it includes complete
            # execution result. Otherwise guessing an operation URL is unsafe.
            if _operation_result(body) is not None and body.get("status") in (None, "SUCCESS"):
                return self._result("", body)
            # The documented response UUID also identifies the status endpoint.
            try:
                operation_id = str(UUID(str(body.get("uuid", ""))))
            except ValueError as error:
                raise SandboxError("sandbox response omitted operation Location and UUID") from error
            operation_url = self._config.base_url.rstrip("/") + "/operations/" + operation_id
        else:
            operation_url = self._absolute_location(str(location))
        if _operation_result(body) is not None and body.get("status") in (None, "SUCCESS"):
            return self._result(operation_url, body)
        return self._poll(operation_url)

    def stage_files(self, files: Mapping[str, bytes]) -> Mapping[str, Mapping[str, str]]:
        """Upload exact bytes and return the documented instance file mapping."""
        staged: dict[str, Mapping[str, str]] = {}
        for path, content in files.items():
            if not _safe_mount_path(path):
                raise ValueError(f"unsafe sandbox file path: {path!r}")
            if not isinstance(content, bytes):
                raise TypeError("sandbox file content must be bytes")
            uploaded = self.upload_file(content)
            staged[path] = {"uuid": uploaded.uuid, "mode": "0644"}
        return staged

    def upload_file(self, content: bytes) -> UploadedFile:
        """Upload content and verify provider-reported digest and size."""
        headers, body = self._request_bytes("POST", "/files", content, "application/octet-stream")
        _ = headers
        uuid = body.get("uuid")
        digest = body.get("sha256")
        size = body.get("size")
        expected = hashlib.sha256(content).hexdigest()
        if not isinstance(uuid, str) or not uuid or digest != expected or size != len(content):
            raise SandboxError("sandbox upload response failed content integrity verification")
        return UploadedFile(uuid=uuid, sha256=digest, size=size)

    def _poll(self, operation_url: str) -> SandboxResult:
        deadline = self._clock() + self._config.timeout_seconds + 30
        while self._clock() < deadline:
            _, body = self._request("GET", operation_url)
            status = body.get("status")
            if status in {"FAILED", "CANCELLED"}:
                raise SandboxError(f"sandbox operation ended with status {status}: {str(body.get('error') or '')[:300]}")
            if status == "SUCCESS":
                return self._result(operation_url, body)
            self._sleep(self._config.poll_interval_seconds)
        raise SandboxError("sandbox operation did not produce a result before worker deadline")

    def _request(self, method: str, path_or_url: str, payload: Mapping[str, Any] | None = None) -> tuple[Mapping[str, str], Mapping[str, Any]]:
        data = json.dumps(payload).encode() if payload is not None else None
        return self._request_bytes(method, path_or_url, data, "application/json")

    def _request_bytes(self, method: str, path_or_url: str, data: bytes | None, content_type: str) -> tuple[Mapping[str, str], Mapping[str, Any]]:
        url = path_or_url if path_or_url.startswith("https://") else self._config.base_url.rstrip("/") + path_or_url
        if not _same_origin(url, self._config.base_url):
            raise SandboxError("sandbox operation URL is outside the configured service origin")
        request = Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self._config.iam_token}",
                "Project": self._config.project_id,
                "Content-Type": content_type,
                "Accept": "application/json",
            },
        )
        try:
            with self._open(request, timeout=min(self._config.timeout_seconds, 30)) as response:
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
            if not _same_origin(location, self._config.base_url):
                raise SandboxError("sandbox Location is outside the configured service origin")
            return location
        if not location.startswith("/"):
            raise SandboxError("sandbox Location must be an absolute URL or path")
        if location.startswith("//"):
            raise SandboxError("sandbox Location must not override the service origin")
        return urljoin(self._config.base_url, location)

    @staticmethod
    def _result(operation_url: str, body: Mapping[str, Any]) -> SandboxResult:
        result = _operation_result(body)
        if body.get("status") not in (None, "SUCCESS"):
            raise SandboxError("sandbox operation is not successful")
        if not isinstance(result, Mapping):
            raise SandboxError("terminal sandbox operation omitted result")
        state = result.get("state") if isinstance(result.get("state"), Mapping) else {}
        stdout = result.get("stdout") if isinstance(result.get("stdout"), Mapping) else {}
        stderr = result.get("stderr") if isinstance(result.get("stderr"), Mapping) else {}
        signal = state.get("signal")
        # Nebius currently emits -1 for ordinary process termination, even
        # when exit_code is 0. Negative values cannot identify a POSIX signal.
        if signal == -1:
            signal = None
        return SandboxResult(
            operation_url=operation_url,
            exit_code=_as_int(state.get("exit_code")),
            timed_out=bool(state.get("timed_out", False)),
            stdout=_decode_stream(stdout),
            stderr=_decode_stream(stderr),
            stdout_truncated=bool(stdout.get("truncated", False) or result.get("truncated", False)),
            stderr_truncated=bool(stderr.get("truncated", False) or result.get("truncated", False)),
            raw=body,
            signal=signal,
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


def _operation_result(body: Mapping[str, Any]) -> Mapping[str, Any] | None:
    metadata = body.get("metadata")
    if isinstance(metadata, Mapping) and isinstance(metadata.get("result"), Mapping):
        return metadata["result"]
    result = body.get("result")
    return result if isinstance(result, Mapping) and isinstance(result.get("state"), Mapping) else None


def _same_origin(candidate: str, configured: str) -> bool:
    candidate_parts, configured_parts = urlsplit(candidate), urlsplit(configured)
    return (
        candidate_parts.scheme == "https"
        and candidate_parts.scheme == configured_parts.scheme
        and candidate_parts.netloc.lower() == configured_parts.netloc.lower()
    )


def _safe_mount_path(path: str) -> bool:
    return path.startswith("/") and "\x00" not in path and all(part not in {"", ".", ".."} for part in path.split("/")[1:])
