import json
import unittest
from email.message import Message
from coai_worker.evidence import ExecutorEvidence
from coai_worker.supabase import SupabaseWorkerConfig, SupabaseWorkerGateway


class Response:
    def __init__(self, body): self._body, self.headers = json.dumps(body).encode(), Message()
    def read(self): return self._body
    def __enter__(self): return self
    def __exit__(self, *_): return False


class SupabaseGatewayTests(unittest.TestCase):
    def gateway(self, response, requests):
        def opener(request, timeout):
            requests.append(request)
            return Response(response)
        return SupabaseWorkerGateway(SupabaseWorkerConfig("https://db.example", "service-key"), opener=opener)

    def test_claim_uses_worker_only_rpc_and_parses_one_run(self):
        requests = []
        gateway = self.gateway([{"run_id":"r","thread_id":"t","prompt":"fix","execution_command":"npm test","execution_cwd":"/workspace","base_sha":"abc","attempt":1,"diff_ids":["d"],"files":[{"path":"src/a.ts","content":"export {}"}]}], requests)
        self.assertEqual("r", gateway.claim("worker-1").run_id)
        self.assertIn("/rpc/claim_agent_run", requests[0].full_url)
        self.assertEqual("Bearer service-key", requests[0].headers["Authorization"])

    def test_rejects_unsafe_repository_path(self):
        requests = []
        gateway = self.gateway([{"run_id":"r","thread_id":"t","prompt":"fix","attempt":1,"diff_ids":[],"files":[{"path":"../secret","content":"no"}]}], requests)
        with self.assertRaises(Exception): gateway.claim("worker-1")

    def test_records_executor_evidence_via_rpc(self):
        requests = []
        gateway = self.gateway([], requests)
        gateway.record_evidence("worker-1", "r", "d", ExecutorEvidence("npm test", True, "ok", False, "https://ops/1"))
        self.assertIn("/rpc/record_executor_evidence", requests[0].full_url)
        self.assertTrue(json.loads(requests[0].data)["p_passed"])
