import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * coai-gh — M3 GitHub connector (production merge path).
 *
 * Contract:
 *   POST { threadId: string, action: "create-pr" | "merge" }
 *   200 { ok: true, prNumber?, branch?, merged? }
 *   200 { ok: false, reason: "gate-locked" | "not-configured" | "bad-request" | "github-error" }
 *
 * The approval gate is checked SERVER-SIDE (migration 0004 helper
 * `thread_can_merge`) with the service-role key — the client cannot bypass it.
 * For demo mode (no GITHUB_PAT / no repo), the frontend merges in-place.
 *
 * Secrets: GITHUB_PAT (fine-grained, contents:write + pull_requests:write on
 * the connected repo), SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (auto).
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
  if (!supabaseUrl || !serviceKey) return json({ ok: false, reason: "bad-request" });

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (token) {
    const { error: authErr } = await sb.auth.getUser(token);
    if (authErr) return json({ ok: false, reason: "bad-request", message: "invalid token" });
  }

  let body: { threadId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, reason: "bad-request", message: "invalid json" });
  }
  const { threadId, action } = body;
  if (!threadId || !action) return json({ ok: false, reason: "bad-request", message: "threadId, action required" });

  const pat = Deno.env.get("GITHUB_PAT");
  const repo = Deno.env.get("GITHUB_REPO"); // e.g. "owner/repo"
  if (!pat || !repo) {
    return json({ ok: false, reason: "not-configured", message: "GITHUB_PAT / GITHUB_REPO not set — demo mode merges in place." });
  }

  // ---- structural gate (server-side, cannot be bypassed) -----------------
  const { data: canMerge } = await sb.rpc("thread_can_merge", { p_thread: threadId });
  if (!canMerge) {
    return json({ ok: false, reason: "gate-locked", message: "Approval threshold + evidence not met — merge is locked." });
  }

  const thread = (await sb.from("threads").select("name,share_code").eq("id", threadId).maybeSingle()).data as
    | { name: string; share_code: string }
    | null;
  const diffs = ((await sb.from("diffs").select("path,label,before,after").eq("thread_id", threadId).is("merged", false).order("ts")).data as
    | { path: string; label: string; before: string; after: string }[]
    | null) ?? [];
  if (!thread || diffs.length === 0) return json({ ok: false, reason: "bad-request", message: "no unmerged diffs" });

  const gh = (path: string, init?: RequestInit) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.headers ?? {}),
      },
    });

  const branch = `co-ai/${thread.share_code.toLowerCase().replace(/\s+/g, "-")}-${Date.now().toString(36)}`;
  const base = Deno.env.get("GITHUB_BASE_BRANCH") ?? "main";

  try {
    if (action === "create-pr") {
      // 1. branch from base
      const baseRef = await (await gh(`/repos/${repo}/git/ref/heads/${base}`)).json();
      await gh(`/repos/${repo}/git/refs`, {
        method: "POST",
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseRef.object.sha }),
      });
      // 2. commit the diffs' `after` contents
      const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
      for (const d of diffs) {
        const blob = await (await gh(`/repos/${repo}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content: d.after, encoding: "utf-8" }),
        })).json();
        tree.push({ path: d.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      const branchRef = await (await gh(`/repos/${repo}/git/ref/heads/${branch}`)).json();
      const newTree = await (await gh(`/repos/${repo}/git/trees`, {
        method: "POST",
        body: JSON.stringify({ base_tree: branchRef.object.sha, tree }),
      })).json();
      const commit = await (await gh(`/repos/${repo}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message: `co-ai: ${thread.name} (${thread.share_code})`, tree: newTree.sha, parents: [branchRef.object.sha] }),
      })).json();
      await gh(`/repos/${repo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: true }),
      });
      // 3. open the PR
      const pr = await (await gh(`/repos/${repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: `co-ai: ${thread.name} (${thread.share_code})`,
          head: branch,
          base,
          body: `Approval-gated AI change from CO-AI. Evidence attached to ${diffs.length} diff(s).`,
        }),
      })).json();
      await sb.from("diffs").update({ branch, pr_number: pr.number }).eq("thread_id", threadId).is("merged", false);
      return json({ ok: true, prNumber: pr.number, branch });
    }

    // action === "merge": squash-merge the PR (gate re-checked above)
    const prRow = ((await sb.from("diffs").select("pr_number,branch").eq("thread_id", threadId).is("merged", false).limit(1).maybeSingle()).data) as
      | { pr_number: number | null; branch: string | null }
      | null;
    if (!prRow?.pr_number) return json({ ok: false, reason: "bad-request", message: "create a PR first" });
    const merged = await (await gh(`/repos/${repo}/pulls/${prRow.pr_number}/merge`, {
      method: "PUT",
      body: JSON.stringify({ merge_method: "squash" }),
    })).json();
    if (merged.merged) {
      await sb.from("diffs").update({ merged: true }).eq("thread_id", threadId).is("merged", false);
      await sb.from("threads").update({ status: "shipped", ts: Date.now() }).eq("id", threadId);
      await sb.from("messages").insert({
        thread_id: threadId, author_id: "system", kind: "system",
        body: `Merged to GitHub (PR #${prRow.pr_number}, squash) — approval gate passed.`, ts: Date.now(),
      });
      return json({ ok: true, merged: true, prNumber: prRow.pr_number });
    }
    return json({ ok: false, reason: "github-error", message: merged.message ?? "merge rejected by GitHub" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, reason: "github-error", message: msg.slice(0, 300) });
  }
});
