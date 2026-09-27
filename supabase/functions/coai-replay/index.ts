import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
const scrub = (value: unknown): unknown =>
  typeof value === "string"
    ? value
        .replace(
          /(gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)/gi,
          "[REDACTED]",
        )
        .slice(0, 20000)
    : Array.isArray(value)
      ? value.map(scrub)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, scrub(item)]),
          )
        : value;
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")
    return json({ ok: false, reason: "bad-request" }, 405);
  const token = (req.headers.get("Authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const url = Deno.env.get("SUPABASE_URL"),
    key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !url || !key)
    return json({ ok: false, reason: "unauthorized" }, 401);
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data: authData, error: authError } = await sb.auth.getUser(token);
  if (authError || !authData.user)
    return json({ ok: false, reason: "unauthorized" }, 401);
  let body: { threadId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, reason: "bad-request", message: "invalid json" });
  }
  if (!body.threadId)
    return json({
      ok: false,
      reason: "bad-request",
      message: "threadId required",
    });
  const { data: member } = await sb
    .from("thread_members")
    .select("thread_id")
    .eq("thread_id", body.threadId)
    .eq("member_id", authData.user.id)
    .maybeSingle();
  if (!member) return json({ ok: false, reason: "forbidden" }, 403);
  const thread = (
    await sb
      .from("threads")
      .select("id,name,share_code,description,status,ts")
      .eq("id", body.threadId)
      .maybeSingle()
  ).data;
  if (!thread) return json({ ok: false, reason: "not-found" }, 404);
  const messages =
    (
      await sb
        .from("messages")
        .select("id,author_id,kind,body,ts")
        .eq("thread_id", body.threadId)
        .order("ts")
    ).data ?? [];
  const steps =
    (
      await sb
        .from("steps")
        .select("id,title,status,owner_id,sort_order,ts")
        .eq("thread_id", body.threadId)
        .order("sort_order")
    ).data ?? [];
  const diffs =
    (
      await sb
        .from("diffs")
        .select("id,path,label,status,revision_hash,evidence_source,ts")
        .eq("thread_id", body.threadId)
        .order("ts")
    ).data ?? [];
  const runs =
    (
      await sb
        .from("agent_runs")
        .select("id,state,attempt,started_at,finished_at")
        .eq("thread_id", body.threadId)
        .order("started_at")
    ).data ?? [];
  const diffIds = diffs.map((d: { id: string }) => d.id),
    runIds = runs.map((r: { id: string }) => r.id);
  const approvals = diffIds.length
    ? ((
        await sb
          .from("approvals")
          .select("diff_id,member_id,verdict,comment,ts")
          .in("diff_id", diffIds)
      ).data ?? [])
    : [];
  const events = runIds.length
    ? ((
        await sb
          .from("run_events")
          .select("run_id,sequence,actor,event_type,created_at")
          .in("run_id", runIds)
          .order("sequence")
      ).data ?? [])
    : [];
  const response = {
    schema: "co-ai.replay.v1",
    exported_at: new Date().toISOString(),
    thread: scrub(thread),
    messages: scrub(messages),
    steps: scrub(steps),
    diffs: scrub(diffs),
    approvals: scrub(approvals),
    runs: scrub(runs),
    events: scrub(events),
    note: "Repository file contents and raw executor output are excluded from replay exports.",
  };
  return new Response(JSON.stringify(response, null, 2), {
    headers: {
      ...cors,
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename=co-ai-${body.threadId}.json`,
    },
  });
});
