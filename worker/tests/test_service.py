import unittest
from coai_worker.nebius import SandboxResult
from coai_worker.service import VerificationWorker
from coai_worker.supabase import ClaimedRun


class Gateway:
    def __init__(self, run): self.run, self.events, self.evidence, self.finished = run, [], [], []
    def claim(self, *_): value, self.run = self.run, None; return value
    def append_event(self, *args): self.events.append(args)
    def record_evidence(self, *args): self.evidence.append(args)
    def finish(self, *args): self.finished.append(args)


class Executor:
    def run(self, *_args, **_kwargs):
        return SandboxResult("https://op", 0, False, "ok", "", False, False, {})


class ServiceTests(unittest.TestCase):
    def test_stages_files_and_records_evidence_for_each_diff(self):
        run = ClaimedRun("r", "t", "fix", "npm test", "/workspace", None, 1, ("d1", "d2"), {"/workspace/src/a.ts": b"x"})
        gateway = Gateway(run)
        outcome = VerificationWorker("w", gateway, Executor()).run_once()
        self.assertEqual("review", outcome.state)
        self.assertEqual(2, len(gateway.evidence))
        self.assertTrue(gateway.finished[-1][-1])

    def test_blocks_a_run_without_a_configured_command(self):
        run = ClaimedRun("r", "t", "fix", None, "/workspace", None, 1, ("d",), {})
        gateway = Gateway(run)
        self.assertEqual("blocked", VerificationWorker("w", gateway, Executor()).run_once().state)
        self.assertFalse(gateway.finished[-1][-1])
