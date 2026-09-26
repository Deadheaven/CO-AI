import unittest
from coai_worker.evidence import evidence_from_result
from coai_worker.nebius import SandboxResult


def result(**overrides):
    payload = {"operation_url": "https://sandbox/ops/1", "exit_code": 0, "timed_out": False, "stdout": "pass", "stderr": "", "stdout_truncated": False, "stderr_truncated": False, "raw": {}}
    payload.update(overrides)
    return SandboxResult(**payload)


class EvidenceTests(unittest.TestCase):
    def test_successful_complete_result_becomes_passing_evidence(self):
        evidence = evidence_from_result("npm test", result())
        self.assertTrue(evidence.passed)
        self.assertIn("[stdout]", evidence.output)

    def test_truncated_output_cannot_become_passing_evidence(self):
        evidence = evidence_from_result("npm test", result(stdout_truncated=True))
        self.assertFalse(evidence.passed)
        self.assertTrue(evidence.truncated)
