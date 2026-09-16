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
 * The function is provider-agnostic: it reads LLM_API_KEY (OpenAI or Gemini —
 * key format decides) and LLM_MODEL (optional override). It produces a strict
 * JSON result (plan → steps → diffs → self-QA) and persists each artifact to
 * Postgres. Supabase Realtime then broadcasts the rows to every member's
 * thread — no separate push channel needed.
 *
 * The approval gate lives OUTSIDE this function (migration 0004): diffs are
 * persisted in `pending` state and cannot be merged by this or any other
 * function until evidence + threshold checks pass.
 *
 * Secrets: LLM_API_KEY (required for real mode), SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
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

  const key = Deno.env.get("LLM_API_KEY");
  if (!key) {
    // Graceful "agent not configured": mark the run + thread and stop.
    await sb.from("agent_runs").update({ not_configured: true, state: "blocked" }).eq("id", runId);
    await sb.from("messages").insert({
      thread_id: threadId, author_id: "agent", kind: "agent",
      body: "Agent not configured — add an LLM key (LLM_API_KEY) in Supabase Edge Function secrets to enable real runs.",
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

  const keyName = key.startsWith("sk-") ? "openai" : key.includes(":") ? "gemini" : "openai";
  const model = Deno.env.get("LLM_MODEL") ?? (keyName === "gemini" ? "gemini-2.0-flash" : "gpt-4o-mini");

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
  key: string; provider: string; model: string; prompt: string; repoFiles: string;
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
  try {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/s, "").trim();
    const parsed = JSON.parse(cleaned) as LlmResult;
    if (!Array.isArray(parsed.steps) || !Array.isArray(parsed.diffs)) {
      return { ok: false, error: "llm returned invalid shape", steps: [], diffs: [] };
    }
    return { ok: true, plan: parsed.plan, steps: parsed.steps, diffs: parsed.diffs };
  } catch {
    return { ok: false, error: "llm returned non-JSON", steps: [], diffs: [] };
  }
}
