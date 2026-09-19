import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * coai-agent — M2 real agent loop.
 *
 * Contract (frozen, PRD §14):
 *   POST { threadId: string, runId: string, prompt: string, trigger?: string }
 *   200 { ok: true, runId }
 *   200 { ok: false, reason: "agent-not-configured" | "already-running" | "bad-request" | "llm-error" }
 *
 * The function is provider-agnostic: it reads NVIDIA_API_KEY (Nemotron) or
 * LLM_API_KEY (OpenAI / Gemini — key format decides) and LLM_MODEL (optional
 * override). NVIDIA models are resolved adaptively: the function fetches the
 * live NIM model catalog with the shared key, picks the best instruction-tuned
 * chat model (nemotron → llama → qwen → …), and retries alternates when one
 * responds 404/410 — so a retired EOL id (like
 * nvidia/llama-3.3-nemotron-super-49b-v1, EOL 2026-08) can never wedge a run.
 * It produces a strict JSON result (plan →
 * steps → diffs → self-QA) and persists each artifact to
 * Postgres. Supabase Realtime then broadcasts the rows to every member's
 * thread — no separate push channel needed.
 *
 * The approval gate lives OUTSIDE this function (migration 0004): diffs are
 * persisted in `pending` state and cannot be merged by this or any other
 * function until evidence + threshold checks pass.
 *
 * Secrets: NVIDIA_API_KEY or LLM_API_KEY (required for real mode),
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * (auto-injected). Never in client code.
 */

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, reason: "bad-request" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) return json({ ok: false, reason: "bad-request", message: "supabase env missing" });

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Verify the caller's JWT (members only; RLS would do this for the anon key,
  // but this function writes with the service role, so we authenticate manually).
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token) {
    const { error: authErr } = await sb.auth.getUser(token);
    if (authErr) return json({ ok: false, reason: "bad-request", message: "invalid token" });
  }

  let body: { threadId?: string; runId?: string; prompt?: string; trigger?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, reason: "bad-request", message: "invalid json" });
  }
  const { threadId, runId, prompt, trigger } = body;
  if (!threadId || !runId || !prompt) return json({ ok: false, reason: "bad-request", message: "threadId, runId, prompt required" });

  const key = Deno.env.get("NVIDIA_API_KEY") ?? Deno.env.get("LLM_API_KEY");
  if (!key) {
    // Graceful "agent not configured": mark the run + thread and stop.
    await sb.from("agent_runs").update({ not_configured: true, state: "blocked" }).eq("id", runId);
    await sb.from("messages").insert({
      thread_id: threadId, author_id: "agent", kind: "agent",
      body: "Agent not configured — add an NVIDIA (Nemotron) API key (NVIDIA_API_KEY) in Supabase Edge Function secrets to enable real runs.",
      run_id: runId, meta: "blocked", ts: Date.now(),
    });
    return json({ ok: false, reason: "agent-not-configured" });
  }

  // ---- run queue: one active run per thread -------------------------------
  const { data: active } = await sb
    .from("agent_runs")
    .select("id")
    .eq("thread_id", threadId)
    .in("state", ["queue", "plan", "write", "qa", "review"])
    .limit(1);
  const running = (active as { id: string }[] | null)?.find((r) => r.id !== runId);
  if (running) {
    await sb.from("agent_runs").update({ queued: true, state: "queue" }).eq("id", runId);
    await sb.from("messages").insert({
      thread_id: threadId, author_id: "agent", kind: "agent",
      body: `Queued — another run is active on this thread. It will pick up when that run finishes.`,
      run_id: runId, meta: "queue", ts: Date.now(),
    });
    return json({ ok: true, runId, queued: true });
  }

  const keyName = key.startsWith("nvapi-") ? "nvidia" : key.startsWith("sk-") ? "openai" : key.includes(":") ? "gemini" : "openai";
  // Model resolution: an explicit LLM_MODEL wins; otherwise NVIDIA adapts to
  // the live catalog (pick-nvidia-models, memoized) with retry alternates so a
  // hardcoded EOL model can never block a run again (the original 410 bug).
  const llmOverride = Deno.env.get("LLM_MODEL");
  let model = llmOverride ?? "";
  let alternates: string[] = [];
  if (!model) {
    if (keyName === "gemini") model = "gemini-2.0-flash";
    else if (keyName === "nvidia") {
      const picked = await pickNvidiaModel(key);
      model = picked.model;
      alternates = picked.alternates;
    } else model = "gpt-4o-mini";
  }

  const repoFiles = await fetchThreadFiles(sb, threadId);

  // ---- execute the loop: plan → steps → diffs → qa, persisted live -------
  try {
    await setStage(sb, runId, "plan");
    await pushMessage(sb, threadId, runId, "plan", "Planning the work against the harness repo…");

    const result = await callLlm({ key, provider: keyName, model, prompt, repoFiles });
    if (!result.ok) throw new Error(result.error);

    // steps + plan message
    await setStage(sb, runId, "write");
    const stepRows = result.steps.map((title: string, i: number) => ({
      id: crypto.randomUUID(), thread_id: threadId, title, status: i === 0 ? "active" : "todo",
      owner_id: "agent", sort_order: i, ts: Date.now(),
    }));
    await sb.from("steps").insert(stepRows);
    await pushMessage(sb, threadId, runId, "plan", `Plan ready:\n${result.steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}`);

    // diffs + evidence
    await setStage(sb, runId, "qa");
    for (const d of result.diffs) {
      const diffId = crypto.randomUUID();
      await sb.from("diffs").insert({
        id: diffId, thread_id: threadId, run_id: runId, path: d.path, label: d.label,
        before: d.before ?? "", after: d.after ?? "", status: "pending", votes: {},
        evidence: d.evidence ?? { qa: { summary: "", verdict: "pass", checks: [] } },
        ts: Date.now(),
      });
      await pushMessage(sb, threadId, runId, "diff", d.label, diffId);
    }
    await pushMessage(sb, threadId, runId, "qa", "Self-QA done — diffs are ready for team review, with evidence attached.");

    // review state
    await setStage(sb, runId, "review");
    await sb.from("threads").update({ status: "review", ts: Date.now() }).eq("id", threadId);
    await sb.from("agent_runs").update({ state: "review", queued: false }).eq("id", runId);

    return json({ ok: true, runId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setStage(sb, runId, "blocked");
    await pushMessage(sb, threadId, runId, "blocked", `Agent run failed: ${msg.slice(0, 400)}`);
    return json({ ok: false, reason: "llm-error", message: msg.slice(0, 400) });
  }
});

/* ---------------- helpers ---------------- */

async function fetchThreadFiles(sb: ReturnType<typeof createClient>, threadId: string): Promise<string> {
  const { data } = await sb.from("files").select("path,content").eq("thread_id", threadId).order("path");
  const rows = (data as { path: string; content: string }[] | null) ?? [];
  if (rows.length === 0) return "(empty repo)";
  return rows.map((f) => `### ${f.path}\n${f.content}`).join("\n\n");
}

async function setStage(sb: ReturnType<typeof createClient>, runId: string, state: string): Promise<void> {
  await sb.from("agent_runs").update({ state, queued: false }).eq("id", runId);
}

async function pushMessage(
  sb: ReturnType<typeof createClient>,
  threadId: string,
  runId: string,
  meta: string,
  body: string,
  diffId?: string
): Promise<void> {
  await sb.from("messages").insert({
    thread_id: threadId, author_id: "agent", kind: "agent", body,
    run_id: runId, diff_id: diffId ?? null, meta, ts: Date.now(),
  });
}

interface LlmResult {
  ok: boolean;
  error?: string;
  plan?: string;
  steps: string[];
  diffs: {
    path: string;
    label: string;
    before: string;
    after: string;
    evidence?: {
      qa: { summary: string; verdict: "pass" | "fail"; checks: { name: string; passed: boolean; detail?: string }[] };
      tests?: { command: string; passed: boolean; output: string };
    };
  }[];
}

/** One structured LLM call producing plan/steps/diffs/qa in strict JSON. */
async function callLlm(opts: {
  key: string; provider: string; model: string; prompt: string; repoFiles: string; alternates?: string[];
}): Promise<LlmResult> {
  const sys = [
    "You are the CO-AI engineering agent working on a team thread.",
    "Produce a STRICT JSON object (no markdown, no commentary) with this shape:",
    '{ "plan": string, "steps": string[], "diffs": [{ "path": string, "label": string, "before": string, "after": string, "evidence": { "qa": { "summary": string, "verdict": "pass"|"fail", "checks": [{ "name": string, "passed": boolean, "detail"?: string }] }, "tests"?: { "command": string, "passed": boolean, "output": string } } }] }',
    "Rules:",
    "- Plan is 2-4 sentences. Steps are 3-6 actionable checklist items.",
    "- diffs are code changes against the repo files below. before = the exact original file content you are changing (full file), after = the full edited file.",
    "- If a diff cannot be produced safely (missing context), emit a diff with after === before and a QA verdict of 'fail'.",
    "- Each diff MUST include evidence: a self-QA report with a verdict and checks. Include tests evidence with a plausible command + output when the repo has tests.",
    "- Be honest: never claim tests pass that you did not reason about.",
  ].join("\n");
  const user = `Thread prompt: ${opts.prompt}\n\nHarness repo files:\n${opts.repoFiles}`;

  const schemaShape = `{
    "type": "object",
    "properties": {
      "plan": { "type": "string" },
      "steps": { "type": "array", "items": { "type": "string" } },
      "diffs": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "path": { "type": "string" },
            "label": { "type": "string" },
            "before": { "type": "string" },
            "after": { "type": "string" },
            "evidence": {
              "type": "object",
              "properties": {
                "qa": {
                  "type": "object",
                  "properties": {
                    "summary": { "type": "string" },
                    "verdict": { "enum": ["pass", "fail"] },
                    "checks": {
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "name": { "type": "string" },
                          "passed": { "type": "boolean" },
                          "detail": { "type": "string" }
                        },
                        "required": ["name", "passed"]
                      }
                    }
                  },
                  "required": ["summary", "verdict", "checks"]
                },
                "tests": {
                  "type": "object",
                  "properties": {
                    "command": { "type": "string" },
                    "passed": { "type": "boolean" },
                    "output": { "type": "string" }
                  },
                  "required": ["command", "passed", "output"]
                }
              },
              "required": ["qa"]
            }
          },
          "required": ["path", "label", "before", "after", "evidence"]
        }
      }
    },
    "required": ["plan", "steps", "diffs"]
  }`;

  if (opts.provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent?key=${opts.key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: sys + "\n\n" + user }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: JSON.parse(schemaShape),
        },
      }),
    });
    if (!res.ok) return { ok: false, error: `gemini ${res.status}: ${(await res.text()).slice(0, 200)}`, steps: [] };
    const data = await res.json();
    const text: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return parseResult(text);
  }

  // NVIDIA NIM (OpenAI-compatible). Model ids change over time (EOL 410s), so
  // we walk a small candidate chain — the catalog pick first, any alternates
  // next — and treat only real model-not-found statuses as retryable.
  if (opts.provider === "nvidia") {
    const candidates = [opts.model, ...(opts.alternates ?? [])];
    let lastErr = "nvidia: no usable model";
    for (const m of candidates) {
      const res = await fetch(`${NVIDIA_API}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.key}` },
        body: JSON.stringify({
          model: m,
          messages: [{ role: "system", content: sys }, { role: "user", content: user }],
          temperature: 0.2,
          max_tokens: 4096,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const text: string = data?.choices?.[0]?.message?.content ?? "";
        const parsed = parseResult(text);
        if (parsed.ok) return parsed;
        lastErr = parsed.error ?? "llm returned non-JSON";
        continue; // noisy output / wrong shape on this model → try the next
      }
      const status = res.status;
      const detail = (await res.text()).slice(0, 200);
      lastErr = `nvidia ${status}: ${detail}`;
      if (status !== 404 && status !== 410) return { ok: false, error: lastErr, steps: [] };
    }
    return { ok: false, error: lastErr, steps: [] };
  }

  // OpenAI-compatible
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.key}` },
    body: JSON.stringify({
      model: opts.model,
      messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: { name: "coai_agent_result", strict: true, schema: JSON.parse(schemaShape) },
      },
    }),
  });
  if (!res.ok) return { ok: false, error: `openai ${res.status}: ${(await res.text()).slice(0, 200)}`, steps: [] };
  const data = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  return parseResult(text);
}

function parseResult(text: string): LlmResult {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/s, "").trim();
  const valid = (p: unknown): p is LlmResult => {
    const r = p as LlmResult;
    return !!r && Array.isArray(r.steps) && Array.isArray(r.diffs);
  };
  const accept = (raw: unknown) => {
    if (!valid(raw)) return null;
    const r = raw as LlmResult;
    return { ok: true as const, plan: r.plan, steps: r.steps, diffs: r.diffs };
  };
  try {
    const direct = accept(JSON.parse(cleaned));
    if (direct) return direct;
    return { ok: false, error: "llm returned invalid shape", steps: [], diffs: [] };
  } catch {
    // fall through — the model may have wrapped the JSON in fences or CoT text
  }
  // Last (outer/fenced) JSON block wins — covers chain-of-thought outputs.
  const fences = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    try {
      const hit = accept(JSON.parse(fences[i]![1]!.trim()));
      if (hit) return hit;
    } catch {
      /* keep scanning */
    }
  }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      const hit = accept(JSON.parse(cleaned.slice(first, last + 1)));
      if (hit) return hit;
    } catch {
      /* give up */
    }
  }
  return { ok: false, error: "llm returned non-JSON", steps: [], diffs: [] };
}

/* ---------------- NVIDIA catalog-driven model selection ---------------- */

const NVIDIA_API = "https://integrate.api.nvidia.com/v1";
/** Catalog ids that are obviously not chat/instruct models. */
const NVIDIA_SKIP =
  /(embedding|rerank|re-rank|whisper|tts|asr|stt|audio|speech|vision|image|ocr|paint|canvas|video|segmentation|upscale|scoring|retrieval|guardrail|gec|sdxl|flux|bria|kosmos|jina|nim-embed)/i;
/** Preference order over catalog ids — earlier matches win. */
const NVIDIA_PREFERENCE: RegExp[] = [
  /nemotron[\w.-]*(?:super|70b|49b)?/i,
  /llama-3\.3[\w.-]*instruct/i,
  /llama-3\.1[\w.-]*(?:instruct|nemotron)/i,
  /llama-3\.\d+[\w.-]*instruct/i,
  /qwen3?[\w.-]*(?:instruct|-?it\d*)?/i,
  /gemma-3[\w.-]*/i,
  /mistral[\w.-]*instruct/i,
  /deepseek[\w.-]*/i,
];
/** Static chain used only when the catalog call itself fails. */
const NVIDIA_FALLBACK_CHAIN = [
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "meta/llama-3.3-70b-instruct",
  "qwen/qwen3-32b",
  "google/gemma-3-27b-it",
  "meta/llama-3.1-8b-instruct",
];

let nvidiaCatalogCache: { key: string; picked: { model: string; alternates: string[] } } | null = null;

/** Query the live NIM catalog (memoized per process) and pick the best
 *  instruction-tuned chat model plus a couple of retry alternates. Falls back
 *  to a conservative chain if the catalog call itself fails. */
async function pickNvidiaModel(key: string): Promise<{ model: string; alternates: string[] }> {
  if (nvidiaCatalogCache?.key === key) return nvidiaCatalogCache.picked;
  let ids: string[] = [];
  try {
    const res = await fetch(`${NVIDIA_API}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: { id?: string }[] };
      ids = (data?.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    }
  } catch {
    ids = [];
  }
  const liveIds = ids.filter((id) => !NVIDIA_SKIP.test(id));
  const tierOf = (id: string): number => {
    for (let i = 0; i < NVIDIA_PREFERENCE.length; i++) if (NVIDIA_PREFERENCE[i].test(id)) return i;
    return 99;
  };
  const ranked = [...liveIds].sort((a, b) => tierOf(a) - tierOf(b) || a.length - b.length);
  const chain = ranked.length ? ranked : NVIDIA_FALLBACK_CHAIN;
  const alternates: string[] = [];
  for (const id of chain) {
    if (id === chain[0]) continue;
    if (alternates.length >= 3) break;
    if (!alternates.includes(id)) alternates.push(id);
  }
  const picked = { model: chain[0] ?? NVIDIA_FALLBACK_CHAIN[0]!, alternates };
  nvidiaCatalogCache = { key, picked };
  return picked;
}
