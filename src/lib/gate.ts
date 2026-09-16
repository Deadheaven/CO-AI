import type { ApprovalPolicy, Diff, DiffStatus, Vote } from "../types";
import { DEFAULT_POLICY } from "../types";

/**
 * M3 — the approval gate, as pure functions.
 *
 * These rules are the single source of truth for "can this diff / thread
 * merge?" and are used by:
 *  1. the UI (progress bars, merge control state),
 *  2. the mock engine (demo mode), and
 *  3. the Edge Functions (real mode) — which re-implement the same checks
 *     server-side with the service-role key so the gate cannot be bypassed.
 *
 * The gate is structural: a diff can only merge when (a) it carries evidence
 * and (b) the team's approval threshold is met. There is no "trust me" path.
 */

export interface GateDecision {
  canMerge: boolean;
  /** Human-readable reason for why the gate is open / shut. */
  reason: string;
  approvals: number;
  required: number;
}

/** Number of distinct team members who approved a diff. */
export function countApprovals(diff: Diff): number {
  return Object.values(diff.votes).filter((v) => v === "approve").length;
}

export function countRejects(diff: Diff): number {
  return Object.values(diff.votes).filter((v) => v === "reject").length;
}

/** The minimum number of approvals the policy requires for a given team size. */
export function requiredApprovals(memberCount: number, policy: ApprovalPolicy = DEFAULT_POLICY): number {
  if (memberCount <= 0) return policy.min;
  if (policy.mode === "all") return memberCount;
  // majority: > half, floored, never below policy.min
  return Math.max(policy.min, Math.floor(memberCount / 2) + 1);
}

/** Evidence is present when the agent attached a QA report with a verdict. */
export function hasEvidence(diff: Diff): boolean {
  return Boolean(diff.evidence?.qa?.verdict);
}

export function hasPassingEvidence(diff: Diff): boolean {
  const qa = diff.evidence?.qa;
  if (!qa?.verdict) return false;
  if (qa.verdict !== "pass") return false;
  // if tests ran, they must have passed too
  if (diff.evidence?.tests && !diff.evidence.tests.passed) return false;
  return true;
}

/** Gate decision for ONE diff (its own evidence + its own votes). */
export function diffGate(
  diff: Diff,
  memberCount: number,
  policy: ApprovalPolicy = DEFAULT_POLICY
): GateDecision {
  const approvals = countApprovals(diff);
  const required = requiredApprovals(memberCount, policy);

  if (countRejects(diff) > 0) {
    return { canMerge: false, reason: "A teammate rejected this diff.", approvals, required };
  }
  if (diff.status === "rejected") {
    return { canMerge: false, reason: "This diff was rejected.", approvals, required };
  }
  if (!hasPassingEvidence(diff)) {
    return { canMerge: false, reason: "Missing passing evidence (self-QA report).", approvals, required };
  }
  if (approvals < required) {
    return {
      canMerge: false,
      reason: `Needs ${required} approvals (${approvals} so far).`,
      approvals,
      required,
    };
  }
  return { canMerge: true, reason: "Threshold met with evidence attached.", approvals, required };
}

/** Whole-thread gate: EVERY diff on the thread must pass its own gate. */
export function threadGate(
  diffs: Diff[],
  memberCount: number,
  policy: ApprovalPolicy = DEFAULT_POLICY
): GateDecision {
  if (diffs.length === 0) {
    return { canMerge: false, reason: "Nothing to merge yet.", approvals: 0, required: 0 };
  }
  let approvals = 0;
  let required = 0;
  for (const d of diffs) {
    const g = diffGate(d, memberCount, policy);
    if (!g.canMerge) return g;
    approvals += g.approvals;
    required += g.required;
  }
  return {
    canMerge: true,
    reason: `All ${diffs.length} diff(s) approved with evidence.`,
    approvals,
    required,
  };
}

/** Whether every pending diff is already individually mergeable (for auto-merge). */
export function allDiffsMergeable(diffs: Diff[], memberCount: number, policy: ApprovalPolicy = DEFAULT_POLICY): boolean {
  return diffs.length > 0 && diffs.every((d) => diffGate(d, memberCount, policy).canMerge);
}

/** Pure apply-vote: returns the next diff state without mutating. */
export function applyVote(
  diff: Diff,
  memberId: string,
  verdict: Vote,
  comment?: string
): Diff {
  const votes = { ...diff.votes, [memberId]: verdict };
  const next: Diff = { ...diff, votes, comment: comment ?? diff.comment };
  // A single reject marks the diff rejected; approval only flips to approved
  // when the diff's gate passes (threshold + evidence) — see store.recountGates.
  // The thread itself never ships from a vote: only store.shipThread (the
  // human "Merge to ship" action) may reach shipped.
  if (verdict === "reject") {
    next.status = "rejected";
  } else {
    next.status = diff.status === "rejected" ? "pending" : diff.status;
  }
  return next;
}

/** Demo-mode: status label shown when merging a diff in-place. */
export function mergeStatus(diff: Diff): DiffStatus {
  return diff.status === "approved" ? "approved" : diff.status;
}
