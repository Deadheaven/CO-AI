import {
  dbWithGuard,
  evidenceFor,
  inferSteps,
  now,
  seedRepo,
  uid,
  withIdempotency,
  withRefund,
} from "./lib/engine";
import type { AgentRun, ChatMsg, Diff, Member, RepoFile, Step, Thread } from "./types";

export const ME_ID = "you";
export const AGENT_ID = "agent";

export const BOTS: Member[] = [
  { id: "mika", name: "Mika", color: "#f0abfc", isBot: true, online: true },
  { id: "rai", name: "Rai", color: "#fda4af", isBot: true, online: true },
];

export const ME: Member = { id: ME_ID, name: "You", color: "#93c5fd", online: true };

export const members: Member[] = [ME, ...BOTS];

/* ---------- tiny seed helpers ---------- */
const T = (minsAgo: number) => now() - minsAgo * 60_000;

function M(
  threadId: string,
  authorId: string,
  kind: ChatMsg["kind"],
  body: string,
  minsAgo: number,
  extras: Partial<ChatMsg> = {}
): ChatMsg {
  return { id: uid(), threadId, authorId, kind, body, ts: T(minsAgo), ...extras };
}

const step = (threadId: string, title: string, status: Step["status"], ownerId?: string): Step => ({
  id: uid(),
  threadId,
  title,
  status,
  ownerId,
});

/* ---------- Thread A: shipped refund endpoint ---------- */
const repoA = seedRepo();
const paymentsA0 = seedRepo().find((f) => f.path === "src/routes/payments.ts")!.content;
const repoA1 = repoA.map((f) =>
  f.path === "src/routes/payments.ts" ? { ...f, content: withRefund(f.content) } : f
);
const afterA = withRefund(paymentsA0);

const diffA: Diff = {
  id: uid(),
  threadId: "t-refund",
  runId: "r-refund",
  path: "src/routes/payments.ts",
  label: "Add idempotent refund endpoint",
  before: paymentsA0,
  after: afterA,
  status: "approved",
  votes: { [ME_ID]: "approve", mika: "approve", rai: "approve" },
  evidence: evidenceFor("Add idempotent refund endpoint", afterA),
  merged: true,
};

const threadA: Thread = {
  id: "t-refund",
  name: "Add /refund endpoint",
  code: "REF-01",
  description: "Customers need a way to refund a charge, safely and idempotently.",
  status: "shipped",
  memberIds: [ME_ID, "mika", "rai"],
  ts: T(180),
};

const msgsA: ChatMsg[] = [
  M("t-refund", ME_ID, "chat", "Refunds keep failing in support tickets — our API has no refund method at all.", 170),
  M("t-refund", AGENT_ID, "agent", "On it. I traced the charge flow and drafted a plan.", 165),
  M("t-refund", "mika", "chat", "Agreed with the plan — idempotency is a must here, or a double refund is a support incident.", 160),
  M("t-refund", AGENT_ID, "diff", "Add idempotent refund endpoint", 150, { diffId: diffA.id, runId: diffA.runId }),
  M("t-refund", AGENT_ID, "agent", "Self-QA passed. Amounts are credited only when the charge exists and isn't already refunded.", 148),
  M("t-refund", "rai", "chat", "LGTM — the change is scoped and safe.", 140),
  M("t-refund", ME_ID, "chat", "Approved from my side. Nice work.", 135),
  M("t-refund", AGENT_ID, "system", "All changes approved by the team — merged and shipped.", 130),
];

const stepsA: Step[] = [
  step("t-refund", "Trace the charge flow end-to-end", "done", ME_ID),
  step("t-refund", "Write the refund endpoint (idempotency-safe)", "done", AGENT_ID),
  step("t-refund", "Review diff + QA edge cases", "done", "rai"),
];

const runA: AgentRun = {
  id: "r-refund",
  threadId: "t-refund",
  prompt: "Add /refund endpoint",
  stage: "done",
  log: ["plan: charge flow traced", "write: generated refund endpoint", "qa: edges covered", "done: approved & merged"],
  startedAt: T(160),
};

/* ---------- Thread B: duplicate charge on retry (waiting on YOU) ---------- */
const repoB = seedRepo();
const payB0 = repoB.find((f) => f.path === "src/routes/payments.ts")!.content;
const dbB0 = repoB.find((f) => f.path === "src/db.ts")!.content;
const repoB1 = repoB.map((f) =>
  f.path === "src/routes/payments.ts" ? { ...f, content: withIdempotency(f.content) } : f
).map((f) =>
  f.path === "src/db.ts" ? { ...f, content: dbWithGuard(f.content) } : f
);

const diffB1: Diff = {
  id: uid(), threadId: "t-dup", runId: "r-dup", path: "src/routes/payments.ts",
  label: "Accept idempotency key on charge",
  before: payB0, after: withIdempotency(payB0), status: "pending", votes: {},
  evidence: evidenceFor("Accept idempotency key on charge", withIdempotency(payB0)),
};
const diffB2: Diff = {
  id: uid(), threadId: "t-dup", runId: "r-dup", path: "src/db.ts",
  label: "Dedupe charges by idempotency key",
  before: dbB0, after: dbWithGuard(dbB0), status: "pending", votes: {},
  evidence: evidenceFor("Dedupe charges by idempotency key", dbWithGuard(dbB0)),
};

const threadB: Thread = {
  id: "t-dup",
  name: "Fix duplicate charge on retry",
  code: "DUP-9",
  description: "Clients retry on timeout and get charged twice. Add an idempotency key.",
  status: "review",
  memberIds: [ME_ID, "mika", "rai"],
  ts: T(22),
};

const msgsB: ChatMsg[] = [
  M("t-dup", "rai", "chat", "A merchant retried a timed-out payment and the customer got charged twice. Top bug right now.", 30),
  M("t-dup", AGENT_ID, "agent", "Reproduced. Root cause: no idempotency on the charge path. Plan:", 28),
  M("t-dup", AGENT_ID, "agent", inferSteps("duplicate charge on retry").map((s, i) => `${i + 1}. ${s}`).join("\n"), 27),
  M("t-dup", AGENT_ID, "diff", "Accept idempotency key on charge", 12, { diffId: diffB1.id, runId: "r-dup" }),
  M("t-dup", AGENT_ID, "diff", "Dedupe charges by idempotency key", 11, { diffId: diffB2.id, runId: "r-dup" }),
  M("t-dup", "rai", "chat", "Two diffs on review — approvals needed. I'm happy with the guard; Mika's double-checking the decrement path.", 6),
];

const stepsB: Step[] = [
  step("t-dup", "Reproduce the duplicate charge on retry", "done", ME_ID),
  step("t-dup", "Add idempotency key to charge path", "done", AGENT_ID),
  step("t-dup", "Verify no double-decrement with a test", "todo", "mika"),
];

const runB: AgentRun = {
  id: "r-dup",
  threadId: "t-dup",
  prompt: "fix duplicate charge on retry",
  stage: "review",
  log: ["plan", "write: 2 files changed", "qa: dedupe path verified"],
  startedAt: T(28),
};

/* ---------- Thread C: fresh, waiting for a prompt ---------- */
const threadC: Thread = {
  id: "t-log",
  name: "Wire up request logging",
  code: "LOG-42",
  description: "Add structured logging so we can debug payment failures in prod.",
  status: "draft",
  memberIds: [ME_ID, "mika", "rai"],
  ts: T(4),
};

const msgsC: ChatMsg[] = [
  M("t-log", "mika", "chat", "Fresh thread. Drop a prompt in the composer and the agent takes it from there — try “fix refund edge case”.", 3),
];

const stepsC: Step[] = [step("t-log", "Scope the logging behavior", "todo", AGENT_ID)];

export interface Seed {
  meId: string;
  members: Member[];
  threads: Thread[];
  messages: ChatMsg[];
  steps: Step[];
  files: Record<string, RepoFile[]>;
  diffs: Diff[];
  runs: Record<string, AgentRun>;
}

export function buildSeed(): Seed {
  return {
    meId: ME_ID,
    members,
    threads: [threadA, threadB, threadC],
    messages: [...msgsA, ...msgsB, ...msgsC],
    steps: [...stepsA, ...stepsB, ...stepsC],
    files: { "t-refund": repoA1, "t-dup": repoB1, "t-log": seedRepo() },
    diffs: [diffA, diffB1, diffB2],
    runs: { [runA.id]: runA, [runB.id]: runB },
  };
}