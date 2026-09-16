import { describe, expect, it } from "vitest";
import {
  allDiffsMergeable,
  applyVote,
  countApprovals,
  diffGate,
  hasEvidence,
  hasPassingEvidence,
  requiredApprovals,
  threadGate,
} from "./gate";
import type { ApprovalPolicy, Diff, Evidence } from "../types";
import { DEFAULT_POLICY } from "../types";

const passEvidence: Evidence = {
  qa: { summary: "ok", verdict: "pass", checks: [{ name: "types", passed: true }] },
  tests: { command: "deno test", passed: true, output: "4 passed" },
};

const failEvidence: Evidence = {
  qa: { summary: "nope", verdict: "fail", checks: [{ name: "types", passed: false }] },
};

const diff = (over: Partial<Diff>): Diff => ({
  id: "d1",
  threadId: "t1",
  runId: "r1",
  path: "src/a.ts",
  label: "change",
  before: "a",
  after: "b",
  status: "pending",
  votes: {},
  ...over,
});

describe("requiredApprovals (threshold)", () => {
  it("defaults to majority with min 2", () => {
    expect(requiredApprovals(1)).toBe(2); // min floor
    expect(requiredApprovals(2)).toBe(2); // 2/2+1 = 2
    expect(requiredApprovals(3)).toBe(2); // 3/2+1 = 2
    expect(requiredApprovals(4)).toBe(3); // 4/2+1 = 3
    expect(requiredApprovals(5)).toBe(3);
  });
  it("all mode requires every member", () => {
    const all: ApprovalPolicy = { mode: "all", min: 2 };
    expect(requiredApprovals(3, all)).toBe(3);
    expect(requiredApprovals(1, all)).toBe(1);
  });
});

describe("evidence gate", () => {
  it("requires a QA verdict", () => {
    expect(hasEvidence(diff({}))).toBe(false);
    expect(hasEvidence(diff({ evidence: passEvidence }))).toBe(true);
  });
  it("fails when QA verdict is fail or tests failed", () => {
    expect(hasPassingEvidence(diff({ evidence: failEvidence }))).toBe(false);
    expect(
      hasPassingEvidence(diff({ evidence: { ...passEvidence, tests: { command: "deno test", passed: false, output: "boom" } } }))
    ).toBe(false);
    expect(hasPassingEvidence(diff({ evidence: passEvidence }))).toBe(true);
  });
});

describe("diffGate (single diff)", () => {
  it("locks without evidence even with votes", () => {
    const d = diff({ votes: { a: "approve", b: "approve" } });
    const g = diffGate(d, 3);
    expect(g.canMerge).toBe(false);
    expect(g.reason).toMatch(/evidence/i);
  });
  it("locks below threshold", () => {
    const d = diff({ evidence: passEvidence, votes: { a: "approve" } });
    const g = diffGate(d, 4);
    expect(g.canMerge).toBe(false);
    expect(g.reason).toMatch(/approvals/i);
  });
  it("unlocks at majority with evidence", () => {
    const d = diff({ evidence: passEvidence, votes: { a: "approve", b: "approve" } });
    expect(diffGate(d, 3).canMerge).toBe(true);
  });
  it("locks on any reject", () => {
    const d = diff({ evidence: passEvidence, votes: { a: "approve", b: "reject" } });
    const g = diffGate(d, 3);
    expect(g.canMerge).toBe(false);
    expect(g.reason).toMatch(/reject/i);
  });
  it("rejected status locks even with full approvals", () => {
    const d = diff({ evidence: passEvidence, votes: { a: "approve", b: "approve" }, status: "rejected" });
    expect(diffGate(d, 3).canMerge).toBe(false);
  });
});

describe("threadGate (whole thread)", () => {
  it("locks when any diff fails", () => {
    const diffs = [
      diff({ evidence: passEvidence, votes: { a: "approve", b: "approve" } }),
      diff({ id: "d2", evidence: passEvidence, votes: { a: "approve" } }),
    ];
    expect(threadGate(diffs, 3).canMerge).toBe(false);
  });
  it("locks with no diffs", () => {
    expect(threadGate([], 3).canMerge).toBe(false);
  });
  it("unlocks when all pass", () => {
    const diffs = [
      diff({ evidence: passEvidence, votes: { a: "approve", b: "approve" } }),
      diff({ id: "d2", evidence: passEvidence, votes: { a: "approve", b: "approve" } }),
    ];
    expect(threadGate(diffs, 3).canMerge).toBe(true);
  });
});

describe("allDiffsMergeable", () => {
  it("true only when every diff passes its gate", () => {
    expect(allDiffsMergeable([diff({ evidence: passEvidence, votes: { a: "approve", b: "approve" } })], 3)).toBe(true);
    expect(allDiffsMergeable([diff({ evidence: passEvidence, votes: { a: "approve" } })], 3)).toBe(false);
    expect(allDiffsMergeable([], 3)).toBe(false);
  });
});

describe("applyVote", () => {
  it("records the vote immutably", () => {
    const before = diff({});
    const after = applyVote(before, "you", "approve");
    expect(after.votes["you"]).toBe("approve");
    expect(before.votes["you"]).toBeUndefined();
    expect(after.status).toBe("pending");
  });
  it("marks rejected on reject and keeps votes", () => {
    const after = applyVote(diff({}), "you", "reject", "needs rework");
    expect(after.status).toBe("rejected");
    expect(after.comment).toBe("needs rework");
  });
  it("countApprovals only counts approves", () => {
    const d = diff({ votes: { a: "approve", b: "reject", c: "approve" } });
    expect(countApprovals(d)).toBe(2);
  });
});

describe("DEFAULT_POLICY shape", () => {
  it("majority with min 2", () => {
    expect(DEFAULT_POLICY).toEqual({ mode: "majority", min: 2 });
  });
});
