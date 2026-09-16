import type { AgentRun, ChatMsg, CopilotMsg, Diff, Member, RepoFile, Step, Thread } from "../types";

/**
 * Demo-mode cross-tab sync (M1 realtime task, deliverable 3).
 *
 * The live layer reconciles via Supabase Realtime (postgres_changes). In demo
 * mode there is no backend, so two tabs of the same preview never see each
 * other. To validate the same UX contract without a backend, the demo store
 * broadcasts its persisted state through the browser's localStorage "storage"
 * event (fires in *other* tabs) and merges it here, idempotently by primary
 * key with "incoming wins" — the exact semantics of applyRealtimeEvent in
 * store.ts. Pure module: no window access, so it is unit-testable in node.
 */

/** The persisted slices that travel between demo tabs. */
export interface TabSnapshot {
  threads: Thread[];
  messages: ChatMsg[];
  steps: Step[];
  diffs: Diff[];
  runs: Record<string, AgentRun>;
  files: Record<string, RepoFile[]>;
  members: Member[];
  copilot: Record<string, CopilotMsg[]>;
}

const SLICE_KEYS = ["threads", "messages", "steps", "diffs", "runs", "files", "members", "copilot"] as const;

/**
 * Decode a localStorage payload written by another tab into the snapshot
 * slices the demo tab-sync merges.
 *
 * zustand persist (createJSONStorage) serializes the store as an envelope —
 * `{"state": {<partialized slices>}, "version": 1}` — NOT as the bare
 * snapshot, so the storage-event handler must unwrap `.state` before merging
 * (a missing unwrap makes `incoming.threads`/`incoming.messages` undefined and
 * silently drops every cross-tab event). Raw snapshot payloads (manual code
 * writes, tests) are also accepted unchanged.
 *
 * Returns null when the payload carries none of the tab-sync slices.
 */
export function decodeTabSnapshot(raw: unknown): Partial<TabSnapshot> | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const candidate: Record<string, unknown> =
    obj.state != null && typeof obj.state === "object" ? (obj.state as Record<string, unknown>) : obj;
  for (const key of SLICE_KEYS) {
    if (key in candidate) return candidate as Partial<TabSnapshot>;
  }
  return null;
}

function unionById<T extends { id: string }>(a: T[] | undefined, b: T[] | undefined): T[] {
  // b (incoming) wins on id conflicts — newest writer is authoritative.
  const map = new Map<string, T>();
  for (const x of a ?? []) map.set(x.id, x);
  for (const x of b ?? []) map.set(x.id, x);
  return [...map.values()];
}

function unionByPath(a: RepoFile[] | undefined, b: RepoFile[] | undefined): RepoFile[] {
  const map = new Map<string, RepoFile>();
  for (const f of a ?? []) map.set(f.path, f);
  for (const f of b ?? []) map.set(f.path, f);
  return [...map.values()];
}

function mergePerKey<T extends { id: string }>(
  cur: Record<string, T[]> | undefined,
  inc: Record<string, T[]> | undefined
): Record<string, T[]> {
  const keys = new Set([...Object.keys(cur ?? {}), ...Object.keys(inc ?? {})]);
  const out: Record<string, T[]> = {};
  for (const k of keys) out[k] = unionById(cur?.[k], inc?.[k]);
  return out;
}

/** Files are keyed by path (no id) — merge with the path-based union. */
function mergeFilesPerKey(
  cur: Record<string, RepoFile[]> | undefined,
  inc: Record<string, RepoFile[]> | undefined
): Record<string, RepoFile[]> {
  const keys = new Set([...Object.keys(cur ?? {}), ...Object.keys(inc ?? {})]);
  const out: Record<string, RepoFile[]> = {};
  for (const k of keys) out[k] = unionByPath(cur?.[k], inc?.[k]);
  return out;
}

/**
 * Merge another tab's snapshot into the local snapshot. Returns the next
 * state plus whether anything actually changed (so the caller can skip
 * re-writing storage, which would otherwise ping-pong between tabs).
 */
export function mergeTabSnapshot(cur: TabSnapshot, incoming: Partial<TabSnapshot>): { next: TabSnapshot; changed: boolean } {
  const next: TabSnapshot = {
    threads: unionById(cur.threads, incoming.threads).sort((a, b) => b.ts - a.ts),
    messages: unionById(cur.messages, incoming.messages).sort((a, b) => a.ts - b.ts),
    steps: unionById(cur.steps, incoming.steps),
    diffs: unionById(cur.diffs, incoming.diffs),
    runs: { ...cur.runs, ...incoming.runs },
    files: mergeFilesPerKey(cur.files, incoming.files),
    members: unionById(cur.members, incoming.members),
    copilot: mergePerKey(cur.copilot, incoming.copilot),
  };
  return { next, changed: JSON.stringify(next) !== JSON.stringify(cur) };
}