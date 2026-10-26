import base64
import hashlib
import json
import unittest
from email.message import Message

from coai_worker.nebius import NebiusSandboxExecutor, SandboxConfig, SandboxError


class Response:
    def __init__(self, body, headers=None):
        self._body = json.dumps(body).encode()
        self.headers = Message()
        for key, value in (headers or {}).items():
            self.headers[key] = value

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class NebiusSandboxExecutorTests(unittest.TestCase):
    def config(self):
        return SandboxConfig("https://sandbox.example", "token", "project", "tag:node:22")

    def test_posts_isolated_disposable_execution_and_decodes_result(self):
        requests = []

        def opener(request, timeout):
            requests.append(request)
            return Response({"result": {"state": {"exit_code": 0, "timed_out": False}, "stdout": {"encoding": "base64", "value": base64.b64encode(b"ok\\n").decode(), "truncated": False}, "stderr": {"value": "", "truncated": False}}}, {"Location": "/operations/abc"})

        result = NebiusSandboxExecutor(self.config(), opener=opener).run("npm test")
        payload = json.loads(requests[0].data)
        self.assertEqual("POST", requests[0].method)
        self.assertEqual("Bearer token", requests[0].headers["Authorization"])
        self.assertEqual("project", requests[0].headers["Project"])
        self.assertTrue(payload["disposable"])
        self.assertFalse(payload["networking"]["enabled"])
        self.assertEqual("ok\\n", result.stdout)
        self.assertTrue(result.passed)

    def test_refuses_missing_operation_location_without_result(self):
        executor = NebiusSandboxExecutor(self.config(), opener=lambda *_, **__: Response({"uuid": "abc"}))
        with self.assertRaises(SandboxError):
            executor.run("npm test")

    def test_rejects_non_https_endpoint(self):
        with self.assertRaises(ValueError):
            SandboxConfig("http://sandbox.example", "token", "project", "tag:node:22")

    def test_uploads_and_mounts_exact_repository_files(self):
        requests = []
        content = b"export const answer = 42;\n"

        def opener(request, timeout):
            requests.append(request)
            if request.full_url.endswith("/files"):
                return Response({"uuid": "file-1", "sha256": hashlib.sha256(content).hexdigest(), "size": len(content)})
            return Response({"result": {"state": {"exit_code": 0, "timed_out": False}, "stdout": {"value": ""}, "stderr": {"value": ""}}})

        NebiusSandboxExecutor(self.config(), opener=opener).run("npm test", files={"/workspace/src/a.ts": content})
        self.assertEqual("application/octet-stream", requests[0].headers["Content-type"])
        payload = json.loads(requests[1].data)
        self.assertEqual({"uuid": "file-1", "mode": "0644"}, payload["files"]["/workspace/src/a.ts"])
        self.assertFalse(payload["networking"]["enabled"])

    def test_rejects_path_traversal_when_staging(self):
        with self.assertRaises(ValueError):
            NebiusSandboxExecutor(self.config(), opener=lambda *_, **__: Response({})).stage_files({"/workspace/../secret": b"no"})

    def test_polls_documented_metadata_result_and_keeps_location_path(self):
        requests = []
        responses = iter([
            Response({"uuid": "12345678-9abc-4aba-9eda-0123456789ab"}, {"Location": "/sandboxes/v1/operations/abc"}),
            Response({"status": "EXECUTING", "metadata": {"result": {"state": {"exit_code": 0}}}}),
            Response({"status": "SUCCESS", "metadata": {"result": {"state": {"exit_code": 0}, "stdout": {"value": "verified"}}}}),
        ])
        def opener(request, timeout):
            requests.append(request)
            return next(responses)
        config = SandboxConfig("https://sandbox.example/sandboxes/v1", "token", "project", "image")
        result = NebiusSandboxExecutor(config, opener=opener, sleeper=lambda _: None).run("python -m unittest")
        self.assertTrue(result.passed)
        self.assertEqual("verified", result.stdout)
        self.assertEqual(3, len(requests))
        self.assertEqual("https://sandbox.example/sandboxes/v1/operations/abc", requests[1].full_url)

    def test_uses_documented_operation_uuid_when_location_is_missing(self):
        responses = iter([Response({"uuid": "12345678-9abc-4aba-9eda-0123456789ab"}), Response({"status": "SUCCESS", "metadata": {"result": {"state": {"exit_code": 1}}}})])
        result = NebiusSandboxExecutor(self.config(), opener=lambda *_, **__: next(responses)).run("false")
        self.assertFalse(result.passed)
        self.assertEqual(1, result.exit_code)

    def test_rejects_failed_operation_even_with_zero_exit_code(self):
        response = {"status": "FAILED", "metadata": {"result": {"state": {"exit_code": 0}}}}
        with self.assertRaises(SandboxError):
            NebiusSandboxExecutor(self.config(), opener=lambda *_, **__: Response(response)).run("true")

    def test_process_signal_cannot_be_passing_evidence(self):
        response = {"status": "SUCCESS", "metadata": {"result": {"state": {"exit_code": 0, "signal": 9}}}}
        result = NebiusSandboxExecutor(self.config(), opener=lambda *_, **__: Response(response)).run("true")
        self.assertFalse(result.passed)

    def test_negative_signal_sentinel_allows_clean_exit(self):
        response = {"status": "SUCCESS", "metadata": {"result": {"state": {"exit_code": 0, "signal": -1, "timed_out": False}}}}
        result = NebiusSandboxExecutor(self.config(), opener=lambda *_, **__: Response(response)).run("true")
        self.assertIsNone(result.signal)
        self.assertTrue(result.passed)

    def test_refuses_cross_origin_operation_location(self):
        for location in ["https://other.example/operations/abc", "//other.example/operations/abc"]:
            with self.subTest(location=location), self.assertRaises(SandboxError):
                NebiusSandboxExecutor(self.config(), opener=lambda *_, **__: Response({}, {"Location": location})).run("true")
