import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { AGENT_ID, ME_ID, buildSeed } from "./seed";
import {
  BOT_NUDGE_POOL,
  BOT_REPLY_POOL,
  evidenceFor,
  inferSteps,
  now,
  pick,
  runMutations,
  seedRepo,
  uid,
} from "./lib/engine";
import {
  bootBackend,
  createLiveThread,
  diffFromRow,
  invokeAgent,
  joinLiveThread,
  memberFromRow,
  msgFromRow,
  persistDiff,
  persistMessage,
  persistRun,
  persistStep,
  runFromRow,
  stepFromRow,
  threadFromRow,
  updateMemberProfile,
  updateThreadStatus,
  voteOnDiff,
} from "./lib/api";
import {
  presenceStaleMs,
  setPresenceRefresher,
  setRealtimeHandler,
  startRealtime,
  stopRealtime,
  trackPresence,
  updateTrackedPresence,
} from "./lib/realtime";
import type { RealtimeEvent } from "./lib/realtime";
import { decodeTabSnapshot, mergeTabSnapshot } from "./lib/tabsync";
import type { TabSnapshot } from "./lib/tabsync";
import { diffGate, threadGate } from "./lib/gate";
import type {
  AgentRun,
  ChatMsg,
  CopilotMsg,
  Diff,
  Member,
  PresenceInfo,
  RepoFile,
  RunStage,
  Step,
  Thread,
} from "./types";
import { DEFAULT_POLICY } from "./types";

export const AGENT = "agent";

/* ---------- live mode ---------- */
let live = false;

/** True once the Supabase backend booted successfully (set by initStore). */
export function isLive(): boolean {
  return live;
}

/** Fire-and-forget sync of every state row touching a thread (live only). */
function syncThread(threadId: string): void {
  if (!live) return;
  const st = useStore.getState();
  st.messages
    .filter((m) => m.threadId === threadId)
    .forEach((m) => void persistMessage(m));
  st.steps
    .filter((x) => x.threadId === threadId)
    .forEach((s) => void persistStep(s));
  st.diffs
    .filter((d) => d.threadId === threadId)
    .forEach((d) => void persistDiff(d));
  Object.values(st.runs)
    .filter((r) => r.threadId === threadId)
    .forEach((r) => void persistRun(r));
}

/** Re-pull the full snapshot after a live mutation (join / create). */
async function resyncLive(): Promise<boolean> {
  const res = await bootBackend();
  if (!res.ok) return false;
  useStore.setState({ ...res.snapshot, simOn: true, copilot: {} });
  return true;
}

/**
 * Boot the application data layer. With Supabase env vars configured the app
 * runs LIVE (anonymous sign-in + persisted tables). Otherwise or on failure
 * it falls back to the identical Zustand/localStorage demo mock.
 */
export async function initStore(): Promise<"live" | "demo"> {
  const res = await bootBackend();
  if (!res.ok) {
    useStore.getState().resetDemo(); // guarantee the demo path stays identical
    startDemoTabSync();
    return "demo";
  }
  live = true;
  useStore.setState({ ...res.snapshot, simOn: true, copilot: {} });
  setRealtimeHandler(applyRealtimeEvent);
  setPresenceRefresher(applyPresenceRefresh);
  startRealtime();
  trackPresence({ id: res.snapshot.me.id, name: res.snapshot.me.name, color: res.snapshot.me.color });
  return "live";
}

/* ---------- timers ---------- */
const timers = new Set<number>();
function later(fn: () => void, ms: number) {
  const t = window.setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
}
function clearTimers() {
  timers.forEach((t) => window.clearTimeout(t));
  timers.clear();
}

const mkMsg = (
  threadId: string,
  authorId: string,
  kind: ChatMsg["kind"],
  body: string,
  extras: Partial<ChatMsg> = {}
): ChatMsg => ({ id: uid(), threadId, authorId, kind, body, ts: now(), ...extras });

interface CoAIState extends ReturnType<typeof buildSeed> {
  simOn: boolean;
  copilot: Record<string, CopilotMsg[]>;
  presence: Record<string, PresenceInfo>;
  sendMessage: (threadId: string, body: string) => void;
  runAgent: (threadId: string, prompt: string) => void;
  vote: (diffId: string, verdict: "approve" | "reject", comment?: string) => void;
  botVote: (diffId: string, memberId: string) => void;
  /** M3: explicitly merge a thread once its gate passes (live: coai-gh; demo: in-place). */
  merge: (threadId: string) => Promise<boolean>;
  toggleStep: (stepId: string) => void;
  addStep: (threadId: string, title: string) => void;
  createThread: (name: string, description: string) => Promise<string>;
  joinThread: (code: string) => Promise<string | null>;
  updateMe: (name: string, color: string) => void;
  askCopilot: (threadId: string, text: string) => void;
  kickstartVotes: (threadId: string) => void;
  resetDemo: () => void;
  setSim: (on: boolean) => void;
}

const scheduledVotes = new Set<string>();

/** Team size used by the gate = humans + bots on the thread (demo) or members. */
function threadTeamSize(thread: Thread, members: Member[]): number {
  return members.filter((m) => thread.memberIds.includes(m.id)).length;
}

/**
 * After any vote lands, re-check each still-pending diff on the thread:
 * when a diff's own gate passes (evidence + approval threshold) it flips to
 * "approved". This NEVER ships — approvals may fill (including from bots), the
 * diff status advances, but the thread itself stays at review until a human
 * clicks "Merge to ship" (see shipThread). The gate becomes a deliberate team
 * decision, not an auto-merge.
 */
function recountGates(threadId: string): void {
  const st = useStore.getState();
  const thread = st.threads.find((t) => t.id === threadId);
  if (!thread || thread.status === "shipped") return;
  const team = threadTeamSize(thread, st.members);
  const flipped: Diff[] = [];
  const diffs = st.diffs.map((d) => {
    if (d.threadId !== threadId || d.status !== "pending") return d;
    if (!diffGate(d, team, DEFAULT_POLICY).canMerge) return d;
    const nd = { ...d, status: "approved" as const };
    flipped.push(nd);
    return nd;
  });
  if (!flipped.length) return;
  useStore.setState({ diffs });
  if (live) flipped.forEach((d) => void persistDiff(d));
}

/**
 * M3 ship — the ONLY path that ships a thread, and it requires an explicit
 * human merge action (the "Merge to ship" control; demo: in-place file
 * update; live: coai-gh validated the merge server-side under RLS, which
 * blocks any client-side merged=true, and this reconciles the snapshot).
 * Structural preconditions, re-checked here so a shipped thread can never
 * carry unapproved work:
 *   (a) every diff on the thread is already "approved" (zero pending), and
 *   (b) the whole-thread gate passes again (evidence + threshold).
 * Shipped is terminal — a late vote or repeat merge is a no-op.
 */
function shipThread(threadId: string): boolean {
  const st = useStore.getState();
  const thread = st.threads.find((t) => t.id === threadId);
  if (!thread || thread.status === "shipped") return false;
  const threadDiffs = st.diffs.filter((d) => d.threadId === threadId);
  if (!threadDiffs.length) return false;
  if (threadDiffs.some((d) => d.status !== "approved")) return false;

  const team = threadTeamSize(thread, st.members);
  const gate = threadGate(threadDiffs, team, DEFAULT_POLICY);
  if (!gate.canMerge) return false;

  const diffs = st.diffs.map((d) => (d.threadId === threadId ? { ...d, status: "approved" as const, merged: true } : d));
  const runId = threadDiffs[0]!.runId;
  const sysMsg = mkMsg(thread.id, AGENT_ID, "system", `Approval gate passed (${gate.approvals}/${gate.required}) — merged and shipped.`);
  useStore.setState({
    diffs,
    threads: st.threads.map((t) => (t.id === thread.id ? { ...t, status: "shipped" as const, ts: now() } : t)),
    steps: st.steps.map((s) => (s.threadId === thread.id ? { ...s, status: "done" as const } : s)),
    runs: { ...st.runs, [runId]: { ...st.runs[runId]!, stage: "done" as RunStage, finishedAt: now() } },
    messages: [...st.messages, sysMsg],
  });
  if (live) {
    diffs.filter((d) => d.threadId === thread.id).forEach((d) => void persistDiff(d));
    void persistMessage(sysMsg);
    void updateThreadStatus(thread.id, "shipped", now());
    syncThread(thread.id);
  }
  return true;
}

export const useStore = create<CoAIState>()(
  persist(
    (set, get) => ({
      ...buildSeed(),
      simOn: true,
      copilot: {},
      presence: {},

      sendMessage: (threadId, body) => {
        const text = body.trim();
        if (!text) return;
        const msg = mkMsg(threadId, get().meId, "chat", text);
        set((s) => ({ messages: [...s.messages, msg] }));
        if (live) void persistMessage(msg);
        if (!live && get().simOn && Math.random() < 0.85) {
          later(() => botReply(threadId), 1300 + Math.random() * 1800);
        }
      },

      runAgent: (threadId, prompt) => {
        const runId = uid();
        const thread = get().threads.find((t) => t.id === threadId);
        if (!thread) return;
        const run: AgentRun = {
          id: runId,
          threadId,
          prompt,
          stage: "queue",
          log: [],
          startedAt: now(),
        };
        set((s) => ({
          runs: { ...s.runs, [runId]: run },
          threads: s.threads.map((t) => (t.id === threadId ? { ...t, status: "planning", ts: now() } : t)),
          messages: [
            ...s.messages,
            mkMsg(threadId, AGENT_ID, "agent", `Agent on the harness — planning “${prompt}”.`, { runId }),
          ],
        }));
        if (live) {
          void persistRun(run);
          void updateThreadStatus(threadId, "planning", now());
          // M2: real loop lives in the coai-agent Edge Function; the client
          // only fires it and reconciles via realtime. If the function is not
          // configured, it marks the run not-configured and we fall back to
          // the local mock so the thread stays usable (PRD §5 error path).
          void invokeAgent({ threadId, runId, prompt }).then((res) => {
            if (res.ok) return;
            const cur = useStore.getState();
            const r = cur.runs[runId];
            if (!r) return;
            useStore.setState({
              runs: { ...cur.runs, [runId]: { ...r, notConfigured: true, stage: "blocked" } },
              threads: cur.threads.map((t) => (t.id === threadId ? { ...t, status: "blocked", ts: now() } : t)),
            });
          });
          return; // real mode: the function drives steps/diffs/messages via DB + realtime
        }

        const logStage = (stage: RunStage, line: string) =>
          set((s) => ({
            runs: {
              ...s.runs,
              [runId]: { ...s.runs[runId]!, stage, log: [...(s.runs[runId]?.log ?? []), line] },
            },
          }));

        later(() => {
          if (get().runs[runId]?.stage === "done") return;
          logStage("plan", "Gathered thread context + repo state");
          const titles = inferSteps(prompt);
          set((s) => ({
            steps: [
              ...s.steps,
              ...titles.map(
                (t2, i): Step => ({
                  id: uid(),
                  threadId,
                  title: t2,
                  status: i === 0 ? "active" : "todo",
                  ownerId: AGENT_ID,
                })
              ),
            ],
            messages: [
              ...s.messages,
              mkMsg(threadId, AGENT_ID, "agent", `Plan ready:\n${titles.map((t2, i) => `${i + 1}. ${t2}`).join("\n")}`, { runId }),
            ],
          }));
          if (live) syncThread(threadId);
        }, 900);

        later(() => {
          if (get().runs[runId]?.stage === "done") return;
          logStage("write", "Generated code against the harness repo");
          const filesNow = get().files[threadId] ?? [];
          const mutations = runMutations(filesNow, prompt);
          const newFiles: RepoFile[] = [...filesNow];
          const newDiffs: Diff[] = [];
          const newMsgs: ChatMsg[] = [];
          mutations.forEach((m) => {
            const diffId = uid();
            newDiffs.push({
              id: diffId, threadId, runId, path: m.path, label: m.label,
              before: m.before, after: m.after, status: "pending", votes: {},
              // M3: demo diffs ship with the same evidence contract as the live agent
              evidence: evidenceFor(m.label, m.after),
            });
            const idx = newFiles.findIndex((f) => f.path === m.path);
            if (idx >= 0) newFiles[idx] = { path: m.path, content: m.after };
            else newFiles.push({ path: m.path, content: m.after });
            newMsgs.push(mkMsg(threadId, AGENT_ID, "diff", m.label, { runId, diffId }));
          });
          set((s) => ({
            files: { ...s.files, [threadId]: newFiles },
            diffs: [...s.diffs, ...newDiffs],
            messages: [...s.messages, ...newMsgs],
          }));
          if (live) syncThread(threadId);
        }, 1900);

        later(() => {
          if (get().runs[runId]?.stage === "done") return;
          logStage("qa", "Self-review: types check, edge cases covered");
          set((s) => ({
            messages: [
              ...s.messages,
              mkMsg(threadId, AGENT_ID, "agent", "Self-QA done — tests still green. Diffs ready for your review.", { runId }),
            ],
          }));
          if (live) syncThread(threadId);
        }, 2900);

        later(() => {
          if (get().runs[runId]?.stage === "done") return;
          logStage("review", "Awaiting team approval");
          set((s) => ({
            threads: s.threads.map((t) => (t.id === threadId ? { ...t, status: "review", ts: now() } : t)),
            runs: { ...s.runs, [runId]: { ...s.runs[runId]!, stage: "review" } },
          }));
          if (live) {
            void updateThreadStatus(threadId, "review", now());
            void persistRun(get().runs[runId]!);
          }
          get().kickstartVotes(threadId);
        }, 3000);
      },

      vote: (diffId, verdict, comment) => {
        const st = get();
        const diff = st.diffs.find((d) => d.id === diffId);
        if (!diff) return;
        const votes = { ...diff.votes, [st.meId]: verdict };
        const status = verdict === "reject" ? ("rejected" as const) : ("pending" as const);
        set((s) => ({
          diffs: s.diffs.map((d) => (d.id === diffId ? { ...d, votes, status, comment: comment ?? d.comment } : d)),
        }));
        if (live) void voteOnDiff(diffId, verdict);
        const thread = st.threads.find((t) => t.id === diff.threadId);
        if (verdict === "reject" && thread) {
          const rejectMsg = mkMsg(thread.id, st.meId, "chat", comment ? `Rejected: ${comment}` : "Rejected — let's rework this diff.");
          const nudgeMsg = mkMsg(thread.id, "rai", "chat", pick(BOT_NUDGE_POOL));
          useStore.setState((s) => ({
            threads: s.threads.map((t) => (t.id === thread.id ? { ...t, status: "blocked", ts: now() } : t)),
            messages: [...s.messages, rejectMsg, nudgeMsg],
          }));
          if (live) {
            void updateThreadStatus(thread.id, "blocked", now());
            void persistMessage(rejectMsg);
            void persistMessage(nudgeMsg);
            syncThread(thread.id);
          }
        }
        if (verdict === "approve") recountGates(diff.threadId);
      },

      botVote: (diffId, memberId) => {
        const st = get();
        const diff = st.diffs.find((d) => d.id === diffId);
        if (!diff) return;
        if (diff.votes[memberId] || diff.status !== "pending") return;
        set((s) => ({
          diffs: s.diffs.map((d) =>
            d.id === diffId ? { ...d, votes: { ...d.votes, [memberId]: "approve" as const } } : d
          ),
        }));
        // Bots fill approval votes but never ship — shipping stays a human
        // action (the "Merge to ship" control). Votes can still flip a diff
        // to "approved" so the UI surfaces the gate state.
        recountGates(diff.threadId);
      },

      merge: async (threadId) => {
        const st = get();
        const thread = st.threads.find((t) => t.id === threadId);
        if (!thread) return false;
        const threadDiffs = st.diffs.filter((d) => d.threadId === threadId);
        const team = threadTeamSize(thread, st.members);
        const gate = threadGate(threadDiffs, team, DEFAULT_POLICY);
        if (!gate.canMerge) {
          // structural: never unlock without the gate
          useStore.setState((s) => ({
            messages: [...s.messages, mkMsg(threadId, AGENT_ID, "system", `Merge locked — ${gate.reason}`)],
          }));
          return false;
        }
        if (live) {
          // real mode: coai-gh re-checks the gate server-side (RLS blocks
          // any client-side merged=true). Best-effort; realtime reconciles.
          const { invokeMerge } = await import("./lib/api");
          const res = await invokeMerge(threadId);
          if (res?.ok) {
            shipThread(threadId);
            return true;
          }
          useStore.setState((s) => ({
            messages: [...s.messages, mkMsg(threadId, AGENT_ID, "system", `Merge unavailable — ${res?.reason ?? "connector not configured"}`)],
          }));
          return false;
        }
        // demo: in-place file update, same contract as the live merge
        shipThread(threadId);
        return true;
      },

      toggleStep: (stepId) => {
        const st = get();
        const step = st.steps.find((x) => x.id === stepId);
        if (!step) return;
        const status = step.status === "done" ? "todo" : "done";
        set((s) => ({
          steps: s.steps.map((x) => (x.id === stepId ? { ...x, status } : x)),
          threads: s.threads.map((t) =>
            t.id === step.threadId && (t.status === "draft" || t.status === "planning")
              ? { ...t, status: "in_progress", ts: now() }
              : t
          ),
        }));
        if (live) {
          void persistStep({ ...step, status });
          const t = get().threads.find((x) => x.id === step.threadId);
          if (t && (t.status === "draft" || t.status === "planning")) void updateThreadStatus(t.id, "in_progress", now());
        }
      },

      addStep: (threadId, title) => {
        const s = get();
        const step: Step = { id: uid(), threadId, title: title.trim(), status: "todo", ownerId: s.meId };
        set(() => ({ steps: [...s.steps, step] }));
        if (live) void persistStep(step);
      },

      createThread: async (name, description) => {
        if (live) {
          const res = await createLiveThread({ name, description, memberId: get().meId });
          if (!res) {
            // Live inserts are RLS-gated server-side; surface a real failure
            // instead of silently creating a local thread the team can never see.
            throw new Error("We couldn't create that thread — try again.");
          }
          await resyncLive();
          return res.id;
        }
        const id = uid();
        const code = name
          .replace(/[^a-z0-9]/gi, "")
          .slice(0, 4)
          .toUpperCase() + "-" + Math.floor(10 + Math.random() * 89);
        const thread: Thread = {
          id,
          name,
          code,
          description,
          status: "draft",
          memberIds: [ME_ID, "mika", "rai"],
          ts: now(),
        };
        set((s) => ({
          threads: [thread, ...s.threads],
          files: { ...s.files, [id]: seedRepo() },
          messages: [
            ...s.messages,
            mkMsg(id, AGENT_ID, "system", `Thread created. Share code ${code} with the team. Say hi, or kick off an agent run:`),
          ],
          steps: [...s.steps, { id: uid(), threadId: id, title: "Scope the work", status: "todo", ownerId: AGENT_ID }],
        }));
        return id;
      },

      joinThread: async (code) => {
        const c = code.trim().toUpperCase();
        if (live) {
          const id = await joinLiveThread(c, get().meId);
          if (!id) return null;
          await resyncLive();
          return id;
        }
        const thread = get().threads.find((t) => t.code.toUpperCase() === c);
        if (!thread) return null;
        if (!thread.memberIds.includes(ME_ID)) {
          set((s) => ({
            threads: s.threads.map((t) => (t.id === thread.id ? { ...t, memberIds: [...t.memberIds, ME_ID] } : t)),
          }));
        }
        return thread.id;
      },

      updateMe: (name, color) => {
        const meIdNow = get().meId;
        const clean = name.trim() || "Member";
        set((s) => ({
          members: s.members.map((m) => (m.id === meIdNow ? { ...m, name: clean, color } : m)),
        }));
        if (live) {
          void updateMemberProfile(meIdNow, clean, color);
          updateTrackedPresence({ id: meIdNow, name: clean, color });
        }
      },

      askCopilot: (threadId, text) => {
        const trimmed = text.trim();
        if (!trimmed) return;
        const st = get();
        const thread = st.threads.find((t) => t.id === threadId);
        const pushUser: CopilotMsg = { id: uid(), role: "user", text: trimmed, ts: now() };
        set((s) => ({
          copilot: { ...s.copilot, [threadId]: [...(s.copilot[threadId] ?? []), pushUser] },
        }));

        let reply = "";
        let runPrompt: string | null = null;
        const lower = trimmed.toLowerCase();
        if (lower.startsWith("/plan ")) {
          runPrompt = trimmed.slice(6);
          reply = `Starting an agent run on the thread with the prompt “${runPrompt}”. You'll see the plan, diffs, and QA live here.`;
        } else if (lower.startsWith("/fix ")) {
          runPrompt = trimmed.slice(5);
          reply = `Reproducing and fixing “${runPrompt}”. Agent is on the harness.`;
        } else if (lower.startsWith("/summary")) {
          reply = copilotSummary(thread, st);
        } else if (lower.startsWith("/steps")) {
          const steps = st.steps.filter((x) => x.threadId === threadId);
          reply = steps.length
            ? steps.map((x) => `[${x.status}] ${x.title}`).join("\n")
            : "No steps yet — the agent adds them when it plans a run.";
        } else if (lower.startsWith("/blockers")) {
          const rejected = st.diffs.filter((d) => d.threadId === threadId && d.status === "rejected");
          reply = rejected.length
            ? `Blocked on ${rejected.length} rejected diff(s):\n- ${rejected.map((d) => d.path).join("\n- ")}`
            : "No blockers right now. Everything pending is awaiting review.";
        } else if (lower.startsWith("/review")) {
          const pending = st.diffs.filter((d) => d.threadId === threadId && d.status === "pending");
          reply = pending.length
            ? `${pending.length} diff(s) awaiting your review:\n- ${pending.map((d) => d.path).join("\n- ")}`
            : "Nothing awaiting review on this thread.";
        } else {
          reply = pick([
            "I'm the thread copilot. Try /summary, /steps, /blockers, /review — or hand me real work with /plan <feature> or /fix <bug>.",
            "I can push this thread forward: /plan a feature, /fix a bug, or /review what's on deck. What's the next move?",
            `Right now this thread is ${(thread?.status ?? "unknown").replace(/_/g, " ")}. Want next steps? Try /blockers or /review.`,
          ]);
        }

        later(() => {
          set((s) => ({
            copilot: {
              ...s.copilot,
              [threadId]: [...(s.copilot[threadId] ?? []), { id: uid(), role: "ai", text: reply, ts: now() }],
            },
          }));
        }, 750);
        if (runPrompt) later(() => get().runAgent(threadId, runPrompt), 1500);
      },

      kickstartVotes: (threadId) => {
        const st = get();
        if (!st.simOn) return;
        const pending = st.diffs.filter((d) => d.threadId === threadId && d.status === "pending");
        if (!pending.length) return;
        pending.forEach((diff) => {
          if (scheduledVotes.has(diff.id)) return;
          scheduledVotes.add(diff.id);
          later(() => {
            const cur = useStore.getState();
            cur.diffs
              .filter((d) => d.id === diff.id && d.status === "pending")
              .forEach((d) => {
                cur.members
                  .filter((m) => m.isBot && !d.votes[m.id])
                  .forEach((bot) => {
                    later(() => {
                      const d2 = useStore.getState().diffs.find((x) => x.id === diff.id);
                      if (d2?.status === "pending") {
                        useStore.getState().botVote(diff.id, bot.id);
                        useStore.setState((s) => ({
                          messages: [...s.messages, mkMsg(threadId, bot.id, "chat", pick(BOT_REPLY_POOL))],
                        }));
                      }
                    }, 500 + Math.random() * 1400);
                  });
              });
          }, 4200 + Math.random() * 2400);
        });
      },

      resetDemo: () => {
        live = false;
        stopRealtime();
        stopDemoTabSync();
        clearTimers();
        set({ ...buildSeed(), simOn: true, copilot: {}, presence: {} });
      },

      setSim: (on) => set({ simOn: on }),
    }),
    {
      name: "coai-store-v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        meId: s.meId,
        members: s.members,
        threads: s.threads,
        messages: s.messages,
        steps: s.steps,
        files: s.files,
        diffs: s.diffs,
        runs: s.runs,
        copilot: s.copilot,
        simOn: s.simOn,
      }),
      version: 1,
    }
  )
);

function botReply(threadId: string) {
  const st = useStore.getState();
  if (!st.simOn) return;
  const bot = st.members.find((m) => m.isBot && Math.random() > 0.4) ?? st.members.find((m) => m.isBot);
  if (!bot) return;
  useStore.setState((s) => ({
    messages: [...s.messages, mkMsg(threadId, bot.id, "chat", pick(BOT_REPLY_POOL))],
  }));
}

function copilotSummary(thread: Thread | undefined, st: CoAIState): string {
  const msgs = st.messages.filter((m) => m.threadId === thread?.id && m.kind !== "system");
  const recent = msgs.slice(-6).map((m) => {
    const author = st.members.find((x) => x.id === m.authorId)?.name ?? "agent";
    return `${author}: ${(m.body ?? "").split("\n")[0]}`;
  });
  return recent.length
    ? `Latest on “${thread?.name}”:\n${recent.join("\n")}`
    : `“${thread?.name}” is fresh — no activity yet.`;
}

/* ---------- demo cross-tab sync (demo only, no backend needed) ---------- */

const STORE_KEY = "coai-store-v1"; // zustand persist key — must match the persist() name
let tabSyncOn = false;
let tabSyncListener: ((e: StorageEvent) => void) | null = null;

/**
 * Demo mode: broadcast the persisted store to other tabs via the localStorage
 * "storage" event (fires only in *other* tabs) and merge idempotently with the
 * same incoming-wins semantics as the live reconciler. This lets the "message
 * lands in every open tab instantly / profile edit shows on the other screen"
 * DoD be validated with zero backend. Live mode never runs this — realtime.ts
 * owns that path — and the merge is pure (tested in tabsync.test.ts).
 */
function startDemoTabSync(): void {
  if (tabSyncOn) return;
  tabSyncOn = true;
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORE_KEY || e.newValue == null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(e.newValue);
    } catch {
      return;
    }
    // zustand persist stores { state, version } — unwrap before merging, or
    // every cross-tab event is silently dropped (incoming.threads undefined).
    const incoming = decodeTabSnapshot(raw);
    if (!incoming) return;
    const s = useStore.getState();
    const cur: TabSnapshot = {
      threads: s.threads,
      messages: s.messages,
      steps: s.steps,
      diffs: s.diffs,
      runs: s.runs,
      files: s.files,
      members: s.members,
      copilot: s.copilot,
    };
    const { next, changed } = mergeTabSnapshot(cur, incoming);
    if (changed) useStore.setState({ ...next });
  };
  window.addEventListener("storage", onStorage);
  tabSyncListener = onStorage;
}

/** Tear down the demo tab sync (demo reset). */
function stopDemoTabSync(): void {
  if (!tabSyncOn) return;
  tabSyncOn = false;
  if (tabSyncListener) window.removeEventListener("storage", tabSyncListener);
  tabSyncListener = null;
}

/* ---------- realtime reconciliation (live only) ---------- */

function upsertById<T extends { id: string }>(arr: T[], item: T): T[] {
  const idx = arr.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...arr, item];
  const cp = arr.slice();
  cp[idx] = item;
  return cp;
}

/** A newly-seen teammate (just joined via share code / first presence) is added. */
function upsertMember(members: Member[], m: Member): Member[] {
  const idx = members.findIndex((x) => x.id === m.id);
  if (idx === -1) return [...members, m];
  const cp = members.slice();
  cp[idx] = m;
  return cp;
}

/** Source-of-truth events from Supabase Realtime. Merges idempotently by PK,
 *  so local writes echoing back are harmless and remote writes always land. */
function applyRealtimeEvent(ev: RealtimeEvent): void {
  const { table, event, row } = ev;
  const st = useStore.getState();
  const id = typeof row.id === "string" ? row.id : String(row.id ?? "");

  switch (table) {
    case "presence": {
      const memberId = String(row.member_id ?? "");
      if (!memberId) break;
      if (event === "DELETE") {
        const presence = { ...st.presence };
        delete presence[memberId];
        useStore.setState({
          presence,
          members: st.members.map((m) => (m.id === memberId ? { ...m, online: false } : m)),
        });
      } else {
        const info: PresenceInfo = {
          memberId,
          name: String(row.name ?? ""),
          color: String(row.color ?? ""),
          online: true,
          lastSeen: Date.parse(String(row.last_seen ?? "")) || Date.now(),
        };
        const member: Member = {
          id: memberId,
          name: info.name || "Member",
          color: info.color || "#93c5fd",
          online: true,
        };
        useStore.setState((s) => ({
          presence: { ...s.presence, [memberId]: info },
          members: upsertMember(s.members, member),
        }));
      }
      break;
    }
    case "members": {
      if (!row.id) break;
      const rowMember = memberFromRow(row);
      useStore.setState((s) => {
        const p = s.presence[rowMember.id];
        const updated: Member = {
          ...rowMember,
          online: rowMember.id === s.meId ? true : Boolean(p),
        };
        return {
          members: s.members.some((x) => x.id === rowMember.id)
            ? s.members.map((x) => (x.id === rowMember.id ? updated : x))
            : [...s.members, updated],
        };
      });
      break;
    }
    case "messages": {
      if (!row.id) break;
      if (event === "DELETE") {
        useStore.setState({ messages: st.messages.filter((x) => x.id !== id) });
      } else {
        const msg = msgFromRow(row);
        useStore.setState({ messages: upsertById(st.messages, msg).sort((a, b) => a.ts - b.ts) });
      }
      break;
    }
    case "steps": {
      if (!row.id) break;
      if (event === "DELETE") {
        useStore.setState({ steps: st.steps.filter((x) => x.id !== id) });
      } else {
        useStore.setState({ steps: upsertById(st.steps, stepFromRow(row)) });
      }
      break;
    }
    case "diffs": {
      if (!row.id) break;
      if (event === "DELETE") {
        useStore.setState({ diffs: st.diffs.filter((x) => x.id !== id) });
      } else {
        useStore.setState({ diffs: upsertById(st.diffs, diffFromRow(row)) });
      }
      break;
    }
    case "approvals": {
      const diffId = String(row.diff_id ?? "");
      const memberId = String(row.member_id ?? "");
      const verdict = row.verdict === "approve" || row.verdict === "reject" ? row.verdict : null;
      if (!diffId || !memberId || !verdict) break;
      useStore.setState({
        diffs: st.diffs.map((d) => d.id === diffId ? { ...d, votes: { ...d.votes, [memberId]: verdict } } : d),
      });
      break;
    }
    case "agent_runs": {
      if (!row.id) break;
      const run = runFromRow(row);
      useStore.setState({ runs: { ...st.runs, [run.id]: run } });
      break;
    }
    case "threads": {
      if (!row.id) break;
      const thread = threadFromRow(row);
      useStore.setState({ threads: upsertById(st.threads, thread).sort((a, b) => b.ts - a.ts) });
      break;
    }
    default:
      break;
  }
}

/** Periodic re-read of the presence table → scale-based online/offline. */
function applyPresenceRefresh(rows: Record<string, PresenceInfo>): void {
  const st = useStore.getState();
  const nowMs = Date.now();
  const map: Record<string, PresenceInfo> = {};
  for (const [id, info] of Object.entries(rows)) {
    map[id] = { ...info, online: id === st.meId ? true : nowMs - info.lastSeen < presenceStaleMs };
  }
  useStore.setState({
    presence: map,
    members: st.members.map((m) => {
      const p = map[m.id];
      if (m.id === st.meId) return { ...m, online: true, name: p?.name || m.name, color: p?.color || m.color };
      return p
        ? { ...m, online: p.online, name: p.name || m.name, color: p.color || m.color }
        : { ...m, online: false };
    }),
  });
}
