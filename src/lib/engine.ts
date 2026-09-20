import type { Evidence, RepoFile, ThreadStatus } from "../types";

/* ---------- basics ---------- */
/** IDs cross the browser/Supabase boundary, so live IDs must be UUIDs. */
export const uid = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
};
export const now = () => Date.now();
export const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const pick = <T,>(arr: readonly T[]): T =>
  arr[Math.floor(Math.random() * arr.length)] ?? (arr[0] as T);

export function seedCode(): string {
  return Array.from({ length: 18 }, (_, i) => `${String(i + 1).padStart(2, " ")} |`).join("\n");
}

/* ---------- naive unified diff (line-scoped) ---------- */
export function buildUnifiedDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const o = a[i];
    const x = b[i];
    if (o === x) continue;
    if (o !== undefined && x !== undefined) lines.push(`- ${o}`, `+ ${x}`);
    else if (o !== undefined) lines.push(`- ${o}`);
    else if (x !== undefined) lines.push(`+ ${x}`);
  }
  return lines.join("\n");
}

/* ---------- seeded demo repo ---------- */
export function seedRepo(): RepoFile[] {
  const server = [
    "// src/server.ts",
    'import { createApp } from "./app.ts";',
    'import { getDb } from "./db.ts";',
    "",
    "const db = getDb();",
    "const app = createApp(db);",
    "",
    "export const handler = async (req: Request) => {",
    "  const url = new URL(req.url);",
    '  if (req.method === "GET" && url.pathname === "/health") {',
    "    return Response.json({ ok: true });",
    "  }",
    "  return app.fetch(req);",
    "};",
    "",
    "if (import.meta.main) {",
    "  Deno.serve({ port: 4000 }, handler);",
    "}",
  ].join("\n");

  const payments = [
    "// src/routes/payments.ts",
    'import type { DB } from "../db.ts";',
    "",
    "export function createPaymentsRoutes(db: DB) {",
    "  return {",
    "    async charge(amount: number, customerId: string) {",
    "      const balance = await db.getBalance(customerId);",
    '      if (balance < amount) return { error: "insufficient_funds" };',
    "      const charge = await db.insertCharge({ amount, customerId });",
    "      await db.decrement(customerId, amount);",
    "      return { charge };",
    "    },",
    "",
    "    async listCharges(customerId: string) {",
    "      return db.listCharges(customerId);",
    "    },",
    "  };",
    "}",
  ].join("\n");

  const db = [
    "// src/db.ts",
    "const store = new Map<string, unknown>();",
    "",
    "export function getDb() {",
    "  return {",
    "    async getBalance(id: string): Promise<number> {",
    "      return (store.get(\"balance:\" + id) as number) ?? 0;",
    "    },",
    "    async decrement(id: string, amount: number) {",
    "      store.set(\"balance:\" + id, (store.get(\"balance:\" + id) as number) - amount);",
    "    },",
    "    async credit(id: string, amount: number) {",
    "      store.set(\"balance:\" + id, (store.get(\"balance:\" + id) as number) + amount);",
    "    },",
    "    async insertCharge(c: { amount: number; customerId: string }) {",
    "      const charge = { id: crypto.randomUUID(), status: \"succeeded\", ...c };",
    "      store.set(\"charge:\" + charge.id, charge);",
    "      return charge;",
    "    },",
    "    async getCharge(id: string) {",
    "      return store.get(\"charge:\" + id) as { id: string; amount: number; customerId: string; status: string } | null;",
    "    },",
    "    async insertRefund(r: { chargeId: string; reason: string }) {",
    "      store.set(\"refund:\" + uid(), r);",
    "    },",
    "    async listCharges() {",
    "      return [...store.entries()].filter(([k]) => k.startsWith(\"charge:\")).map(([, v]) => v);",
    "    },",
    "  };",
    "}",
  ].join("\n");

  const validator = [
    "// src/lib/validator.ts",
    "export function isPositiveInt(v: unknown): v is number {",
    '  return typeof v === "number" && Number.isInteger(v) && v > 0;',
    "}",
    "export function isNonEmptyString(v: unknown): v is string {",
    '  return typeof v === "string" && v.trim().length > 0;',
    "}",
  ].join("\n");

  return [
    { path: "src/server.ts", content: server },
    { path: "src/routes/payments.ts", content: payments },
    { path: "src/db.ts", content: db },
    { path: "src/lib/validator.ts", content: validator },
  ];
}

/* ---------- real-looking agent mutations ---------- */
export interface Mutation {
  path: string;
  label: string;
  before: string;
  after: string;
}

export const withRefund = (payments: string) =>
  payments.replace(
    "  return {\n    async charge(amount: number, customerId: string) {",
    `  return {\n    async charge(amount: number, customerId: string) {`
  ).replace(
    "    async listCharges(customerId: string) {",
    `    async refund(chargeId: string, reason: string) {\n      const charge = await db.getCharge(chargeId);\n      if (!charge) return { error: "charge_not_found" };\n      if (charge.status === "refunded") return { error: "already_refunded" };\n      await db.insertRefund({ chargeId, reason });\n      await db.credit(charge.customerId, charge.amount);\n      return { refunded: charge.amount };\n    },\n\n    async listCharges(customerId: string) {`
  );

export const withIdempotency = (payments: string) =>
  payments.replace(
    "async charge(amount: number, customerId: string) {",
    "async charge(amount: number, customerId: string, idempotencyKey?: string) {"
  ).replace(
    "      const charge = await db.insertCharge({ amount, customerId });",
    "      const existing = idempotencyKey ? await db.getCharge(idempotencyKey) : null;\n      if (existing) return { charge: existing };\n      const charge = await db.insertCharge({ amount, customerId }, idempotencyKey);"
  );

export const dbWithGuard = (db: string) =>
  db.replace(
    "return {\n    async getBalance",
    "return {\n    async getBalance"
  ).replace(
    'async insertCharge(c: { amount: number; customerId: string }) {',
    'async insertCharge(c: { amount: number; customerId: string }, key?: string) {\n      if (key && store.has("charge:" + key)) return store.get("charge:" + key);'
  );

const withLogging = (server: string) =>
  server.replace(
    "export const handler = async (req: Request) => {\n  const url = new URL(req.url);",
    "export const handler = async (req: Request) => {\n  const url = new URL(req.url);\n  const t0 = performance.now();\n  console.log(\"[req]\", req.method, url.pathname);"
  );

export function runMutations(files: RepoFile[], prompt: string): Mutation[] {
  const q = prompt.toLowerCase();
  const file = (p: string) => {
    const f = files.find((x) => x.path === p);
    return f?.content ?? "";
  };

  const base = {
    server: file("src/server.ts"),
    payments: file("src/routes/payments.ts"),
    db: file("src/db.ts"),
    validator: file("src/lib/validator.ts"),
  };

  const out: Mutation[] = [];

  if (q.includes("refund") || q.includes("endpoint")) {
    const after = withRefund(base.payments);
    out.push({ path: "src/routes/payments.ts", label: "Add idempotent refund endpoint", before: base.payments, after });
  }
  if (q.includes("duplicate") || q.includes("retry") || q.includes("double") || q.includes("idempoten")) {
    const a1 = withIdempotency(base.payments);
    const a2 = dbWithGuard(base.db);
    out.push({ path: "src/routes/payments.ts", label: "Accept idempotency key on charge", before: base.payments, after: a1 });
    out.push({ path: "src/db.ts", label: "Dedupe charges by idempotency key", before: base.db, after: a2 });
  }
  if (q.includes("log") || q.includes("health") || q.includes("observab") || q.includes("req")) {
    const after = withLogging(base.server);
    out.push({ path: "src/server.ts", label: "Add request logging middleware", before: base.server, after });
  }
  if (out.length === 0) {
    out.push({ path: "src/lib/validator.ts", label: "Add amount sanity check", before: base.validator, after: withAmountCheck(base.validator) });
  }
  return out;
}

const withAmountCheck = (v: string) =>
  v.replace(
    "export function isNonEmptyString",
    "export function isNonEmptyString"
  ).replace(
    "export function isPositiveInt",
    "export function isSafeAmount(v: unknown): v is number {\n  return isPositiveInt(v) && v <= 1_000_000;\n}\n\nexport function isPositiveInt"
  );

/* ---------- steps inferred from a prompt ---------- */
export function inferSteps(prompt: string): string[] {
  const q = prompt.toLowerCase();
  const base: string[] = [];
  if (q.includes("refund") || q.includes("endpoint")) {
    base.push("Trace the charge flow end-to-end", "Write the refund endpoint (idempotency-safe)", "Review diff + QA edge cases");
  } else if (q.includes("duplicate") || q.includes("retry") || q.includes("double")) {
    base.push("Reproduce the duplicate charge on retry", "Add idempotency key to charge path", "Verify no double-decrement with a test");
  } else if (q.includes("log")) {
    base.push("Instrument request lifecycle", "Add structured request logging", "Confirm log volume stays sane");
  } else {
    base.push(`Scope “${prompt}”`, "Implement the change", "Self-review + QA pass");
  }
  return base;
}

/* ---------- M3: demo self-QA evidence for a diff ---------- */
/** Build the mock agent's evidence card for a mutation (demo mode parity). */
export function evidenceFor(label: string, after: string): Evidence {
  const hasReturn = after.includes("return {");
  const hasGuard = after.includes("if (!") || after.includes("if (") || after.includes("error:");
  return {
    qa: {
      summary: `Self-QA passed for “${label}”: change is scoped, types intact, edge cases covered.`,
      verdict: "pass",
      checks: [
        { name: "Types & imports resolve", passed: true },
        { name: "Guard clauses for error paths", passed: hasGuard, detail: hasGuard ? undefined : "No explicit guard found — acceptable for pure additions." },
        { name: "Return shape unchanged for existing callers", passed: hasReturn, detail: hasReturn ? undefined : "Existing callers keep their contract." },
      ],
    },
    tests: {
      command: "deno test --allow-none",
      passed: true,
      output: [
        "check file:///src/routes/payments.ts",
        "check file:///src/db.ts",
        "running 4 tests",
        "  ✓ charge creates a charge",
        "  ✓ refund credits balance once",
        "  ✓ duplicate idempotency key returns existing charge",
        "  ✓ validator rejects negative amounts",
        "test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured",
      ].join("\n"),
    },
  };
}

/* ---------- thread status order ---------- */
export const STATUS_ORDER: ThreadStatus[] = [
  "draft",
  "planning",
  "in_progress",
  "review",
  "shipped",
];

export const stageLabel = (s: string) =>
  ({ queue: "queued", plan: "planning", write: "writing", qa: "QA pass", review: "awaiting review", done: "done" })[s] ?? s;

/* ---------- bot reply pools ---------- */
export const BOT_REPLY_POOL = [
  "Agreed. Keep the idempotency key required so retries can't double-send.",
  "Good call — I'm watching the diff. Looks clean so far.",
  "I think we should also add a regression test here before this ships.",
  "Saw your note. The failure mode on retry is exactly what the agent is fixing.",
  "That matches the plan. Approving once the QA pass finishes.",
  "Careful with the balance read — it's not transactional yet. Worth a step?",
];

export const BOT_APPROVE_POOL = [
  "LGTM — the change is scoped and safe.",
  "Approved. Diff is clean, tests still pass.",
  "Good change. Shipping it.",
];

export const BOT_NUDGE_POOL = [
  "This diff is still open — anyone want to review it?",
  "Bumping this. One review away from shipping.",
];

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}
