import { getSupabase } from "./supabase";
import type {
  AgentRun,
  ChatMsg,
  Diff,
  Member,
  PresenceInfo,
  RepoFile,
  RunStage,
  Step,
  Thread,
  ThreadStatus,
  Vote,
} from "../types";

/**
 * Data layer over Supabase. Every function here is RLS-gated: an anonymous
 * member can only touch rows for threads/workspaces they belong to.
 * Returns null / { ok: false } on any failure so the caller can fall back
 * to the local mock (DEMO_MODE) without crashing.
 */

export const COLORS = ["#93c5fd", "#f0abfc", "#fda4af", "#86efac", "#fcd34d", "#67e8f9", "#a5b4fc"];

export interface Snapshot {
  meId: string;
  me: Member;
  members: Member[];
  presence: Record<string, PresenceInfo>;
  threads: Thread[];
  messages: ChatMsg[];
  steps: Step[];
  files: Record<string, RepoFile[]>;
  diffs: Diff[];
  runs: Record<string, AgentRun>;
}

type Row = Record<string, unknown>;

export function memberFromRow(r: Row): Member {
  return {
    id: String(r.id),
    name: (r.display_name as string) || "Member",
    color: (r.color as string) || COLORS[0],
    online: true,
  };
}

export function threadFromRow(r: Row): Thread {
  const ts = Number(r.ts ?? 0) || (r.created_at ? new Date(String(r.created_at)).getTime() : 0);
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    code: String(r.share_code ?? ""),
    description: String(r.description ?? ""),
    status: (r.status as ThreadStatus) ?? "draft",
    memberIds: [],
    ts,
  };
}

export function msgFromRow(r: Row): ChatMsg {
  const m: ChatMsg = {
    id: String(r.id),
    threadId: String(r.thread_id),
    authorId: String(r.author_id ?? "system"),
    kind: (r.kind as ChatMsg["kind"]) ?? "chat",
    ts: Number(r.ts ?? 0),
  };
  if (r.body != null) m.body = String(r.body);
  if (r.run_id != null) m.runId = String(r.run_id);
  if (r.diff_id != null) m.diffId = String(r.diff_id);
  if (r.parent_id != null) m.parentId = String(r.parent_id);
  if (r.meta != null) m.meta = String(r.meta);
  return m;
}

export function stepFromRow(r: Row): Step {
  const s: Step = {
    id: String(r.id),
    threadId: String(r.thread_id),
    title: String(r.title ?? ""),
    status: (r.status as Step["status"]) ?? "todo",
  };
  if (r.owner_id != null) s.ownerId = String(r.owner_id);
  return s;
}

export function diffFromRow(r: Row): Diff {
  const d: Diff = {
    id: String(r.id),
    threadId: String(r.thread_id),
    runId: String(r.run_id ?? ""),
    path: String(r.path ?? ""),
    label: String(r.label ?? ""),
    before: String(r.before ?? ""),
    after: String(r.after ?? ""),
    status: (r.status as Diff["status"]) ?? "pending",
    votes: (r.votes as Record<string, Vote>) ?? {},
  };
  if (r.comment != null) d.comment = String(r.comment);
  if (r.evidence != null) d.evidence = r.evidence as Diff["evidence"];
  if (r.merged != null) d.merged = Boolean(r.merged);
  if (r.pr_number != null) d.prNumber = Number(r.pr_number);
  if (r.branch != null) d.branch = String(r.branch);
  return d;
}

export function runFromRow(r: Row): AgentRun {
  const run: AgentRun = {
    id: String(r.id),
    threadId: String(r.thread_id),
    prompt: String(r.prompt ?? ""),
    stage: (r.state as RunStage) ?? "queue",
    log: Array.isArray(r.log) ? (r.log as string[]) : [],
    startedAt: Number(r.started_at ?? 0),
  };
  if (r.finished_at != null) run.finishedAt = Number(r.finished_at);
  if (r.trigger != null) run.trigger = String(r.trigger);
  if (r.not_configured != null) run.notConfigured = Boolean(r.not_configured);
  if (r.queued != null) run.queued = Boolean(r.queued);
  return run;
}

/**
 * Boot the live backend:
 * 1. anonymous sign-in (auto-creates a member row with display name + color)
 * 2. ensure the single v1 workspace exists
 * 3. pull the full snapshot the store needs
 * 4. seed nothing except a starter thread when the workspace is brand new
 *
 * Returns { ok: false, reason } when unconfigured / boot fails → DEMO_MODE.
 */
export async function bootBackend(): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; reason: string }> {
  const sb = getSupabase();
  if (!sb) return { ok: false, reason: "supabase env vars not configured" };

  // -- identity ---------------------------------------------------------
  let userId = (await sb.auth.getSession()).data.session?.user?.id;
  if (!userId) {
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) {
      console.warn("[co-ai] anonymous sign-in failed:", error.message);
      return { ok: false, reason: error.message };
    }
    userId = data.user?.id;
    if (!userId) return { ok: false, reason: "no user id after sign-in" };
  }

  // ensure member profile exists
  const { data: existingMe } = await sb.from("members").select("id,display_name,color").eq("id", userId).maybeSingle();
  const meRow: Row = existingMe ?? {
    id: userId,
    display_name: "You",
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
  if (!existingMe) {
    const { error: insErr } = await sb.from("members").insert({
      id: meRow.id,
      display_name: meRow.display_name,
      color: meRow.color,
    });
    if (insErr) {
      console.warn("[co-ai] member insert failed:", insErr.message);
      return { ok: false, reason: insErr.message };
    }
  }

  // 2. workspace ------------------------------------------------------------
  let wsId: string | undefined;
  const { data: wsList } = await sb.from("workspaces").select("id").limit(1);
  wsId = (wsList as Row[] | null)?.[0]?.id as string | undefined;
  if (!wsId) {
    const { data: newWs, error: wsErr } = await sb
      .from("workspaces")
      .insert({ name: "CO-AI workspace" })
      .select("id")
      .single();
    if (wsErr) {
      console.warn("[co-ai] workspace insert failed:", wsErr.message);
      return { ok: false, reason: wsErr.message };
    }
    wsId = (newWs as Row).id as string;
  }

  // 3. snapshot --------------------------------------------------------------
  try {
    const [membersRes, tmsRes, threadsRes, msgsRes, stepsRes, filesRes, diffsRes, runsRes, approvalsRes, presenceRes] =
      await Promise.all([
        sb.from("members").select("*"),
        sb.from("thread_members").select("thread_id,member_id"),
        sb.from("threads").select("*").order("created_at", { ascending: false }),
        sb.from("messages").select("*").order("ts", { ascending: true }),
        sb.from("steps").select("*").order("sort_order", { ascending: true }),
        sb.from("files").select("*"),
        sb.from("diffs").select("*"),
        sb.from("agent_runs").select("*"),
        sb.from("approvals").select("diff_id,member_id,verdict"),
        sb.from("presence").select("*"),
      ]);

    const threadRows = (threadsRes.data as Row[] | null) ?? [];
    const tmRows = (tmsRes.data as Row[] | null) ?? [];
    const memberRows = (membersRes.data as Row[] | null) ?? [];

    const presenceMap: Record<string, PresenceInfo> = {};
    for (const p of (presenceRes.data as Row[] | null) ?? []) {
      const pid = String(p.member_id);
      presenceMap[pid] = {
        memberId: pid,
        name: String(p.name ?? ""),
        color: String(p.color ?? COLORS[0]),
        online: true,
        lastSeen: Date.parse(String(p.last_seen ?? "")) || Date.now(),
      };
    }

    const membersById = new Map<string, Member>();
    memberRows.forEach((r) => {
      const m = memberFromRow(r);
      m.online = m.id === userId || Boolean(presenceMap[m.id]);
      membersById.set(m.id, m);
    });
    const me = membersById.get(userId) ?? memberFromRow(meRow);
    me.online = true;

    const threadMap = new Map<string, string[]>();
    tmRows.forEach((tm) => {
      const tId = String(tm.thread_id);
      const mId = String(tm.member_id);
      threadMap.set(tId, [...(threadMap.get(tId) ?? []), mId]);
    });

    const threads = threadRows.map((t) => {
      const thread = threadFromRow(t);
      thread.memberIds = threadMap.get(String(t.id)) ?? [userId];
      return thread;
    });

    // fresh workspace → seed exactly one starter thread (no bots, no demo repo)
    if (threads.length === 0) {
      const starter = await seedStarterThread(sb, wsId, userId);
      if (starter) {
        const { data: starterRows } = await sb
          .from("threads")
          .select("*")
          .eq("id", starter);
        const t = (starterRows as Row[] | null)?.[0];
        if (t) {
          const thread = threadFromRow(t);
          thread.memberIds = [userId];
          threads.unshift(thread);
        }
      }
    }

    const messages = ((msgsRes.data as Row[] | null) ?? []).map(msgFromRow);
    const steps = ((stepsRes.data as Row[] | null) ?? []).map(stepFromRow);
    const files: Record<string, RepoFile[]> = {};
    for (const f of (filesRes.data as Row[] | null) ?? []) {
      const tid = String(f.thread_id);
      files[tid] = [...(files[tid] ?? []), { path: String(f.path), content: String(f.content ?? "") }];
    }
    const diffs = ((diffsRes.data as Row[] | null) ?? []).map(diffFromRow);
    const runs: Record<string, AgentRun> = {};
    for (const r of (runsRes.data as Row[] | null) ?? []) {
      const run = runFromRow(r);
      runs[run.id] = run;
    }
    // aggregate approvals into diff votes
    for (const a of (approvalsRes.data as Row[] | null) ?? []) {
      const diffId = String(a.diff_id);
      const diff = diffs.find((d) => d.id === diffId);
      if (diff) diff.votes[String(a.member_id)] = a.verdict as Vote;
    }

    return {
      ok: true,
      snapshot: {
        meId: me.id,
        me,
        members: [...membersById.values()],
        presence: presenceMap,
        threads,
        messages,
        steps,
        files,
        diffs,
        runs,
      },
    };
  } catch (e) {
    console.warn("[co-ai] snapshot failed:", e);
    return { ok: false, reason: "snapshot-fetch-failed" };
  }
}

/* ---------- write helpers (fire-and-forget; RLS enforces scope) ---------- */

/** Seed exactly one starter thread for a brand-new REAL workspace (no bots, no demo repo). */
async function seedStarterThread(
  sb: NonNullable<ReturnType<typeof getSupabase>>,
  wsId: string,
  memberId: string
): Promise<string | null> {
  const code = makeCode("Kickstart");
  const { data: rows, error } = await sb
    .from("threads")
    .insert({
      workspace_id: wsId,
      name: "First line of work",
      share_code: code,
      description: "Your team's live workspace is up. Create a thread and the agent will plan the work with you.",
    })
    .select("id");
  if (error || !rows || !rows[0]) return null;
  const threadId = (rows[0] as Row).id as string;
  await sb.from("thread_members").insert({ thread_id: threadId, member_id: memberId });
  await sb.from("messages").insert({
    thread_id: threadId,
    author_id: "system",
    kind: "system",
    body: `Thread created. Share code ${code} with your team — say hi, or kick off an agent run:`,
  });
  return threadId;
}

export async function updateMemberProfile(memberId: string, name: string, color: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { error } = await sb.from("members").update({ display_name: name, color }).eq("id", memberId);
  return !error;
}

export async function createLiveThread(payload: {
  name: string; description: string; memberId: string;
}): Promise<{ id: string; code: string } | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const code = makeCode(payload.name);
  const { data: wsRows } = await sb.from("workspaces").select("id").limit(1);
  const wsId = (wsRows as Row[] | null)?.[0]?.id as string | undefined;
  if (!wsId) return null;
  const { data: threadRows, error } = await sb
    .from("threads")
    .insert({ workspace_id: wsId, name: payload.name, share_code: code, description: payload.description })
    .select("id");
  if (error || !threadRows || !threadRows[0]) return null;
  const threadId = (threadRows[0] as Row).id as string;
  await sb.from("thread_members").insert({ thread_id: threadId, member_id: payload.memberId });
  await sb.from("messages").insert({
    thread_id: threadId, author_id: "system", kind: "system",
    body: `Thread created. Share code ${code} with the team — say hi, or kick off an agent run:`,
  });
  return { id: threadId, code };
}

export async function joinLiveThread(code: string, memberId: string): Promise<string | null> {
  const sb = getSupabase();
  if (!sb) return null;
  const { data: rows } = await sb.from("threads").select("id").eq("share_code", code.toUpperCase()).limit(1);
  const threadId = (rows as Row[] | null)?.[0]?.id as string | undefined;
  if (!threadId) return null;
  await sb.from("thread_members").insert({ thread_id: threadId, member_id: memberId });
  return threadId;
}

export async function persistMessage(msg: ChatMsg): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { error } = await sb.from("messages").insert({
    id: msg.id, thread_id: msg.threadId, author_id: msg.authorId, kind: msg.kind,
    body: msg.body ?? null, parent_id: msg.parentId ?? null, run_id: msg.runId ?? null,
    diff_id: msg.diffId ?? null, meta: msg.meta ?? null, ts: msg.ts,
  });
  return !error;
}

export async function persistStep(step: Step): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { error } = await sb.from("steps").upsert({
    id: step.id, thread_id: step.threadId, title: step.title, status: step.status,
    owner_id: step.ownerId ?? null, ts: Date.now(),
  });
  return !error;
}

export async function persistDiff(diff: Diff, evidence?: unknown): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { error } = await sb.from("diffs").upsert({
    id: diff.id, thread_id: diff.threadId, run_id: diff.runId || null, path: diff.path,
    label: diff.label, before: diff.before, after: diff.after, status: diff.status,
    votes: diff.votes as Row, comment: diff.comment ?? null,
    evidence: evidence ?? diff.evidence ?? null,
    merged: diff.merged ?? false,
    pr_number: diff.prNumber ?? null,
    branch: diff.branch ?? null,
    ts: Date.now(),
  });
  return !error;
}

export async function voteOnDiff(diffId: string, memberId: string, verdict: Vote): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { data: diffRows } = await sb.from("diffs").select("votes,status").eq("id", diffId).maybeSingle();
  if (!diffRows) return false;
  const votes = { ...((diffRows as Row).votes as Record<string, Vote> ?? {}), [memberId]: verdict };
  const status = verdict === "reject" ? "rejected" : "pending";
  const { error } = await sb
    .from("approvals")
    .upsert({ diff_id: diffId, member_id: memberId, verdict: verdict === "approve" ? "approve" : "reject" });
  if (!error) await sb.from("diffs").update({ votes, status }).eq("id", diffId);
  return !error;
}

export async function persistRun(run: AgentRun): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { error } = await sb.from("agent_runs").upsert({
    id: run.id, thread_id: run.threadId, prompt: run.prompt, state: run.stage,
    log: run.log, started_at: run.startedAt,
    finished_at: run.finishedAt ?? null,
    trigger: run.trigger ?? null,
    not_configured: run.notConfigured ?? false,
    queued: run.queued ?? false,
  });
  return !error;
}

export async function updateThreadStatus(threadId: string, status: string, ts: number): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { error } = await sb.from("threads").update({ status, ts }).eq("id", threadId);
  return !error;
}

export function makeCode(name: string): string {
  const letters = name.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase();
  return (letters || "WRK") + "-" + Math.floor(10 + Math.random() * 89);
}

export const isDemo = !getSupabase();

/* ---------- presence (M1 realtime team layer) ---------- */

export function presenceFromRow(r: Row): PresenceInfo {
  const memberId = String(r.member_id);
  return {
    memberId,
    name: String(r.name ?? ""),
    color: String(r.color ?? COLORS[0]),
    online: true,
    lastSeen: Date.parse(String(r.last_seen ?? "")) || Date.now(),
  };
}

/** Current presence rows, keyed by member id. */
export async function fetchPresence(): Promise<Record<string, PresenceInfo>> {
  const sb = getSupabase();
  if (!sb) return {};
  const { data } = await sb.from("presence").select("*");
  const out: Record<string, PresenceInfo> = {};
  for (const r of (data as Row[] | null) ?? []) out[String(r.member_id)] = presenceFromRow(r);
  return out;
}

/** Announce I'm here (join + heartbeat). Idempotent upsert. */
export async function upsertPresence(m: { id: string; name: string; color: string }): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { error } = await sb
    .from("presence")
    .upsert(
      { member_id: m.id, name: m.name, color: m.color, last_seen: new Date().toISOString() },
      { onConflict: "member_id" }
    );
  return !error;
}

/** Best-effort leave (tab hide / unload) so teammates see you drop instantly. */
export async function clearPresence(memberId: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;
  const { error } = await sb.from("presence").delete().eq("member_id", memberId);
  return !error;
}

/* ---------- M2/M3: Edge Function calls ---------- */

export interface AgentInvokeResult {
  ok: boolean;
  reason?: string;
  queued?: boolean;
  message?: string;
}

/** Fire the coai-agent Edge Function for a real LLM run (M2). */
export async function invokeAgent(payload: { threadId: string; runId: string; prompt: string }): Promise<AgentInvokeResult> {
  const sb = getSupabase();
  if (!sb) return { ok: false, reason: "not-configured" };
  try {
    const { data, error } = await sb.functions.invoke("coai-agent", {
      body: payload,
    });
    if (error) return { ok: false, reason: error.message };
    return (data as AgentInvokeResult) ?? { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface MergeInvokeResult {
  ok: boolean;
  reason?: string;
  prNumber?: number;
  merged?: boolean;
  message?: string;
}

/** Ask coai-gh to open a PR / merge once the gate passes (M3, real repo mode). */
export async function invokeMerge(threadId: string): Promise<MergeInvokeResult> {
  const sb = getSupabase();
  if (!sb) return { ok: false, reason: "not-configured" };
  try {
    const { data, error } = await sb.functions.invoke("coai-gh", {
      body: { threadId, action: "merge" },
    });
    if (error) return { ok: false, reason: error.message };
    return (data as MergeInvokeResult) ?? { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}