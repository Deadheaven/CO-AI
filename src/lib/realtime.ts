import { getSupabase } from "./supabase";
import { clearPresence, fetchPresence, upsertPresence } from "./api";
import type { PresenceInfo } from "../types";
import type { RealtimeChannel } from "@supabase/supabase-js";

/**
 * M1 — live team layer.
 *
 * Server-driven reconciliation over Supabase Realtime:
 *  - postgres_changes subscriptions for every table the store renders
 *    (presence, members, messages, steps, diffs, agent_runs, threads) → each
 *    event is handed to the store's reconciler (setRealtimeHandler), which
 *    merges by primary key idempotently. RLS does the authorization: a stream
 *    only ever delivers rows the JWT may SELECT, so threads/workspaces you
 *    don't belong to never arrive.
 *  - presence: a per-member DB row (presence table) upserted on join and
 *    heartbeated every 25s, cleared on tab hide / unload. A 20s sweeper
 *    re-reads presence so stale rows (crashed tab) flip offline after ~2min.
 *
 * Demo mode never touches this module: it is only started when the Supabase
 * backend booted successfully.
 */

export type RealtimeRow = Record<string, unknown>;

export interface RealtimeEvent {
  table: string;
  event: "INSERT" | "UPDATE" | "DELETE";
  row: RealtimeRow;
}

const LIVE_TABLES = ["presence", "members", "messages", "steps", "diffs", "agent_runs", "threads", "workspaces"] as const;

const BEAT_MS = 25_000; // presence heartbeat
const SWEEP_MS = 20_000; // re-read presence (crash detection + missed events)
const STALE_MS = 120_000; // last_seen older than this ⇒ offline

let handler: ((ev: RealtimeEvent) => void) | null = null;
let presenceRefresher: ((rows: Record<string, PresenceInfo>) => void) | null = null;
let channels: RealtimeChannel[] = [];
let started = false;
let beatTimer: ReturnType<typeof setInterval> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let me: { id: string; name: string; color: string } | null = null;

export function setRealtimeHandler(h: ((ev: RealtimeEvent) => void) | null): void {
  handler = h;
}

export function setPresenceRefresher(fn: ((rows: Record<string, PresenceInfo>) => void) | null): void {
  presenceRefresher = fn;
}

function emit(ev: RealtimeEvent): void {
  try {
    handler?.(ev);
  } catch (e) {
    console.warn("[co-ai] realtime handler threw:", e);
  }
}

async function refreshPresence(): Promise<void> {
  const rows = await fetchPresence();
  try {
    presenceRefresher?.(rows);
  } catch (e) {
    console.warn("[co-ai] presence refresh threw:", e);
  }
}

/** Subscribe to postgres changes for every live table. Safe to call once. */
export function startRealtime(): void {
  const sb = getSupabase();
  if (!sb || started) return;
  started = true;

  const ch = sb.channel("coai-live");
  for (const table of LIVE_TABLES) {
    ch.on("postgres_changes", { event: "*", schema: "public", table }, (payload) => onPayload(table, payload));
  }
  ch.subscribe((status, err) => {
    if (status === "SUBSCRIBED") void refreshPresence();
    else if (status === "CHANNEL_ERROR" || status === "CLOSED") console.warn("[co-ai] realtime:", status, err?.message);
  });
  channels.push(ch);

  // sweeper: cover missed events + crash-stale presence
  if (!sweepTimer) sweepTimer = setInterval(() => void refreshPresence(), SWEEP_MS);
}

function onPayload(table: string, payload: RealtimeRow): void {
  emit({
    table,
    event: (payload.eventType as RealtimeEvent["event"]) ?? "INSERT",
    row: (payload.new as RealtimeRow) ?? (payload.old as RealtimeRow) ?? {},
  });
}

/** Threshold the store uses to decide "online" from last_seen. */
export const presenceStaleMs = STALE_MS;

/** Start publishing presence for the current member (heartbeat + leave hooks). */
export function trackPresence(m: { id: string; name: string; color: string }): void {
  me = m;
  void upsertPresence(m);
  if (!beatTimer) beatTimer = setInterval(() => void (me && upsertPresence(me)), BEAT_MS);
  window.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onLeave);
  window.addEventListener("beforeunload", onLeave);
}

/** Re-publish presence after a profile edit so teammates see it instantly. */
export function updateTrackedPresence(m: { id: string; name: string; color: string }): void {
  me = m;
  void upsertPresence(m);
}

function onVisibility(): void {
  if (document.visibilityState === "hidden") void leaveNow();
  else if (me) void upsertPresence(me);
}
function onLeave(): void {
  void leaveNow();
}
function leaveNow(): void {
  if (me) void clearPresence(me.id);
}

/** Tear down subscriptions + presence hooks (demo reset). */
export function stopRealtime(): void {
  const sb = getSupabase();
  if (sb) {
    for (const ch of channels) void sb.removeChannel(ch).catch(() => undefined);
  }
  channels = [];
  if (beatTimer) clearInterval(beatTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  beatTimer = null;
  sweepTimer = null;
  window.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("pagehide", onLeave);
  window.removeEventListener("beforeunload", onLeave);
  me = null;
  started = false;
  handler = null;
  presenceRefresher = null;
}