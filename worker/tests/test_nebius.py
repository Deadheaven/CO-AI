import base64
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
