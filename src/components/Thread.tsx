import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileCode2,
  FolderOpen,
  MessageSquare,
  PanelRight,
  Send,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import { Avatar, AvatarStack, Button, CopyButton, EmptyState, LiveDot, StatusPill, cn } from "./ui";
import { useStore } from "../store";
import { STATUS_ORDER, buildUnifiedDiff, fmtTime } from "../lib/engine";
import { invokeGhImport } from "../lib/api";
import type { ChatMsg, CopilotMsg, Diff, RepoFile, Step, ThreadStatus } from "../types";

/* Module-level constant: stable reference for the empty copilot history,
   so the useStore selector never allocates a fresh array per snapshot call
   (which would trip useSyncExternalStore's infinite-loop guard). */
const EMPTY_COPILOT: CopilotMsg[] = [];

/* ================= status rail ================= */
function StatusRail({ status }: { status: ThreadStatus }) {
  const idx = STATUS_ORDER.indexOf(status);
  return (
    <div className="rounded-xl border border-border bg-panel p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-foreground/45">Thread status</div>
      <div className="flex items-center gap-1">
        {STATUS_ORDER.map((s, i) => {
          const done = i < idx || status === "shipped";
          const active = i === idx;
          const blocked = status === "blocked";
          return (
            <div key={s} className="flex flex-1 items-center gap-1" aria-label={s}>
              <span
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold",
                  done ? "bg-success/20 text-success" : active ? (blocked ? "bg-destructive/20 text-destructive" : "bg-accent/20 text-accent") : "bg-foreground/10 text-foreground/30"
                )}
              >
                {done ? <Check size={10} /> : active && !blocked ? <CircleDot size={10} /> : i + 1}
              </span>
              {i < STATUS_ORDER.length - 1 && (
                <span className={cn("h-px flex-1", i < idx ? "bg-success/50" : "bg-border")} />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[8.5px] uppercase tracking-wide text-foreground/40">
        {STATUS_ORDER.map((s) => (
          <span key={s} className="w-9 text-center">
            {s.replace("_", " ")}
          </span>
        ))}
      </div>
      {status === "blocked" && (
        <p className="mt-2 rounded-lg bg-destructive/10 px-2 py-1.5 text-[10.5px] text-destructive">
          Blocked — the last agent run needs attention. Message the team, then kick off a new run.
        </p>
      )}
    </div>
  );
}

/* ================= steps ================= */
function StepsPanel({ threadId, steps, members }: { threadId: string; steps: Step[]; members: Map<string, { name: string; color: string }> }) {
  const toggleStep = useStore((s) => s.toggleStep);
  const addStep = useStore((s) => s.addStep);
  const [title, setTitle] = useState("");
  const [open, setOpen] = useState(false);
  const tSteps = steps.filter((s) => s.threadId === threadId);

  return (
    <div className="rounded-xl border border-border bg-panel">
      <button
        className="flex w-full cursor-pointer items-center justify-between px-3 py-2.5 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="text-[10px] font-bold uppercase tracking-widest text-foreground/45">
          Steps · {tSteps.filter((s) => s.status === "done").length}/{tSteps.length}
        </span>
        {open ? <ChevronDown size={13} className="text-foreground/45" /> : <ChevronRight size={13} className="text-foreground/45" />}
      </button>
      {open && (
        <div className="flex flex-col gap-1 border-t border-border/70 px-2 py-2">
          {tSteps.length === 0 && (
            <p className="px-1 py-1 text-[11px] text-foreground/45">No steps yet — the agent adds them when it plans a run.</p>
          )}
          {tSteps.map((s) => {
            const owner = s.ownerId ? members.get(s.ownerId) : undefined;
            return (
              <div key={s.id} className="group flex items-start gap-2 rounded-lg px-1.5 py-1 transition hover:bg-muted">
                <button
                  role="checkbox"
                  aria-checked={s.status === "done"}
                  onClick={() => toggleStep(s.id)}
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded border transition",
                    s.status === "done" ? "border-success bg-success/20 text-success" : "border-border hover:border-foreground/50"
                  )}
                >
                  {s.status === "done" && <Check size={11} />}
                </button>
                <span className={cn("flex-1 text-[11.5px] leading-snug", s.status === "done" && "text-foreground/40 line-through")}>{s.title}</span>
                {owner && (
                  <span className="shrink-0" title={owner.name}>
                    <Avatar name={owner.name} color={owner.color} size={14} />
                  </span>
                )}
              </div>
            );
          })}
          <form
            className="flex gap-1.5 px-1 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (title.trim()) {
                addStep(threadId, title.trim());
                setTitle("");
              }
            }}
          >
            <label htmlFor="new-step" className="sr-only">
              Add a step
            </label>
            <input
              id="new-step"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Add a step…"
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-canvas px-2 text-[11px] placeholder:text-foreground/30 focus:border-foreground/50 focus:outline-none"
            />
            <Button type="submit" variant="outline" size="sm" aria-label="Add step">
              Add
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

/* ================= diff card ================= */
function DiffCard({ diff, members, onOpenFile }: { diff: Diff; members: Map<string, { name: string; color: string; online?: boolean }>; onOpenFile: (p: string) => void }) {
  const vote = useStore((s) => s.vote);
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const voters = [...members.entries()].filter(([, m]) => m);
  const approvalCount = voters.filter(([id]) => diff.votes[id] === "approve").length;
  const required = Math.max(2, Math.floor(voters.length / 2) + 1);
  const pct = Math.min(100, Math.round((approvalCount / Math.max(1, required)) * 100));
  const text = useMemo(() => buildUnifiedDiff(diff.path, diff.before, diff.after), [diff]);
  const hasEvidence = Boolean(diff.evidence?.qa?.verdict);
  const evidencePass = diff.evidence?.qa?.verdict === "pass" && (!diff.evidence?.tests || diff.evidence.tests.passed);
  const [evOpen, setEvOpen] = useState(false);
  const statusChip =
    diff.status === "approved" ? (
      <span className="rounded-full bg-success/12 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-success">approved</span>
    ) : diff.status === "rejected" ? (
      <span className="rounded-full bg-destructive/12 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-destructive">rejected</span>
    ) : (
      <span className="rounded-full bg-warning/12 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-warning">needs review</span>
    );

  return (
    <div className={cn("overflow-hidden rounded-xl border bg-panel", diff.status === "approved" ? "border-success/30" : diff.status === "rejected" ? "border-destructive/30" : "border-agent/30")}>
      <button className="flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <FileCode2 size={15} className="shrink-0 text-agent" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px] text-foreground/85">{diff.path}</span>
          <span className="block truncate text-[10px] text-foreground/50">{diff.label}</span>
        </span>
        {diff.merged && (
          <span className="rounded-full bg-success/12 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-success">merged</span>
        )}
        {statusChip}
        {open ? <ChevronDown size={13} className="text-foreground/40" /> : <ChevronRight size={13} className="text-foreground/40" />}
      </button>

      {open && (
        <div className="border-t border-border/70">
          <div className="scroll-thin max-h-56 overflow-auto p-1.5">
            <pre className="code-block p-2 text-[10.5px] leading-relaxed">
              {text.split("\n").map((l, i) => (
                <div key={i} className={cn(l.startsWith("+") && "diff-add", l.startsWith("-") && "diff-del", l.startsWith("@@") && "bg-foreground/10")}>
                  {l || " "}
                </div>
              ))}
            </pre>
          </div>

          {/* M3: evidence */}
          <div className="border-t border-border/70">
            <button
              onClick={() => setEvOpen(!evOpen)}
              aria-expanded={evOpen}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left",
                hasEvidence ? (evidencePass ? "text-success" : "text-destructive") : "text-foreground/50"
              )}
            >
              <ShieldCheck size={13} className={cn("shrink-0", evidencePass ? "text-success" : "text-foreground/40")} />
              <span className="text-[10.5px] font-semibold">
                {hasEvidence ? (evidencePass ? "Evidence attached — self-QA passed" : "Evidence attached — self-QA failed") : "No evidence yet"}
              </span>
              {evOpen ? <ChevronDown size={12} className="ml-auto" /> : <ChevronRight size={12} className="ml-auto" />}
            </button>
            {evOpen && diff.evidence && (
              <div className="scroll-thin max-h-48 space-y-2 overflow-auto border-t border-border/70 px-3 py-2">
                <p className="text-[11px] leading-relaxed text-foreground/70">{diff.evidence.qa.summary}</p>
                <ul className="flex flex-col gap-1">
                  {diff.evidence.qa.checks.map((c, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-[10.5px]">
                      {c.passed ? <Check size={11} className="mt-0.5 shrink-0 text-success" /> : <X size={11} className="mt-0.5 shrink-0 text-destructive" />}
                      <span className={c.passed ? "text-foreground/75" : "text-destructive"}>{c.name}</span>
                      {c.detail && <span className="text-foreground/45">— {c.detail}</span>}
                    </li>
                  ))}
                </ul>
                {diff.evidence.tests && (
                  <details className="rounded-lg border border-border bg-canvas/60">
                    <summary className="cursor-pointer px-2 py-1.5 font-mono text-[10px] text-foreground/65">
                      {diff.evidence.tests.command} <span className={diff.evidence.tests.passed ? "text-success" : "text-destructive"}>{diff.evidence.tests.passed ? "✓ passed" : "✕ failed"}</span>
                    </summary>
                    <pre className="scroll-thin max-h-32 overflow-auto whitespace-pre-wrap px-2 pb-2 font-mono text-[9.5px] leading-relaxed text-foreground/60">{diff.evidence.tests.output}</pre>
                  </details>
                )}
              </div>
            )}
          </div>

          {/* M3: approval progress */}
          {diff.status === "pending" && (
            <div className="border-t border-border/70 px-3 py-2">
              <div className="mb-1 flex items-center justify-between text-[10px]">
                <span className="text-foreground/55">Team approval</span>
                <span className="text-foreground/45">{approvalCount}/{required} · {pct}%</span>
              </div>
              <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                <div className={cn("h-full rounded-full transition-all duration-300", pct >= 100 ? "bg-success" : "bg-accent")} style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-foreground/45">{approvalCount}/{voters.length} approved</span>
              <span className="flex items-center -space-x-1">
                {voters.map(([id, m]) => (
                  <span key={id} title={`${m.name} ${diff.votes[id] ? `— ${diff.votes[id]}` : "— hasn't voted"}`}>
                    <Avatar name={m.name} color={m.color} size={16} />
                    {diff.votes[id] && (
                      <span className="ml-[-2px] inline-flex items-center justify-center rounded-full bg-panel text-[8px]">
                        {diff.votes[id] === "approve" ? <Check size={8} className="text-success" /> : <X size={8} className="text-destructive" />}
                      </span>
                    )}
                  </span>
                ))}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => onOpenFile(diff.path)} aria-label={`Open ${diff.path}`}>
                view file
              </Button>
              {diff.status === "pending" && (
                <>
                  <Button variant="primary" size="sm" onClick={() => vote(diff.id, "approve")}>
                    <ThumbsUp size={12} /> Approve
                  </Button>
                  {rejecting ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        placeholder="Why not?"
                        className="h-8 w-36 rounded-md border border-border bg-canvas px-2 text-[11px] placeholder:text-foreground/30 focus:outline-none"
                        aria-label="Rejection note"
                      />
                      <Button variant="danger" size="sm" onClick={() => { vote(diff.id, "reject", note.trim() || undefined); setRejecting(false); setNote(""); }}>
                        Reject
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}><X size={12} /></Button>
                    </div>
                  ) : (
                    <Button variant="danger" size="sm" onClick={() => setRejecting(true)}>
                      <ThumbsDown size={12} /> Reject
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
          {diff.comment && (
            <p className="border-t border-border/70 px-3 py-2 text-[11px] text-destructive">Rejected: {diff.comment}</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ================= message ================= */
const AGENT_STAGE: Record<string, string> = {
  plan: "plan",
  write: "write",
  qa: "QA",
  review: "review",
  queue: "queue",
};

function Message({
  m,
  meId,
  members,
  diffs,
  onOpenFile,
}: {
  m: ChatMsg;
  meId: string;
  members: Map<string, { name: string; color: string; online?: boolean }>;
  diffs: Diff[];
  onOpenFile: (p: string) => void;
}) {
  const author = members.get(m.authorId);
  const isMe = m.authorId === meId;
  const diff = m.diffId ? diffs.find((d) => d.id === m.diffId) : undefined;

  if (m.kind === "system") {
    return (
      <div className="my-2 flex justify-center">
        <span className="max-w-[85%] rounded-full border border-border bg-panel px-3 py-1 text-center text-[10.5px] leading-relaxed text-foreground/55">
          {m.body}
        </span>
      </div>
    );
  }

  if (m.kind === "agent") {
    return (
      <div className="rise flex gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-agent/40 bg-agent/10 text-agent" aria-hidden="true">
          <Bot size={15} />
        </span>
        <div className="flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] font-bold text-agent">CO-AI agent</span>
            {m.meta && <span className={cn("rounded-full px-1.5 py-px text-[8.5px] font-bold uppercase tracking-wider", AGENT_STAGE[m.meta] === "QA" ? "bg-success/12 text-success" : "bg-foreground/8 text-foreground/55")}>{m.meta}</span>}
            <span className="text-[9.5px] text-foreground/35">{fmtTime(m.ts)}</span>
          </div>
          <div className="w-fit max-w-[92%] rounded-2xl rounded-tl-sm border border-agent/25 bg-panel px-3.5 py-2.5 text-[12px] leading-relaxed">
            <pre className="font-sans whitespace-pre-wrap">{m.body}</pre>
          </div>
        </div>
      </div>
    );
  }

  if (m.kind === "diff" && diff) {
    return <DiffCard diff={diff} members={members} onOpenFile={onOpenFile} />;
  }

  return (
    <div className={cn("rise flex gap-2.5", isMe && "flex-row-reverse")}>
      <Avatar name={author?.name ?? "?"} color={author?.color ?? "#888"} size={28} online={author?.online} />
      <div className={cn("max-w-[80%]", isMe && "text-right")}>
        <div className={cn("mb-0.5 flex items-baseline gap-2", isMe && "justify-end")}>
          <span className="text-[11px] font-bold" style={{ color: author?.color }}>
            {author?.name}
          </span>
          <span className="text-[9.5px] text-foreground/35">{fmtTime(m.ts)}</span>
        </div>
        <div className={cn("inline-block rounded-2xl px-3.5 py-2 text-left text-[12px] leading-relaxed", isMe ? "rounded-tr-sm bg-primary text-on-primary" : "rounded-tl-sm border border-border bg-panel")}>
          {m.body}
        </div>
      </div>
    </div>
  );
}

/* ================= main room ================= */
export default function ThreadRoom({ id, onBack }: { id: string; onBack: () => void }) {
  const threads = useStore((s) => s.threads);
  const members = useStore((s) => s.members);
  const messages = useStore((s) => s.messages);
  const steps = useStore((s) => s.steps);
  const diffs = useStore((s) => s.diffs);
  const runs = useStore((s) => s.runs);
  const files = useStore((s) => s.files);
  const meId = useStore((s) => s.meId);
  const sendMessage = useStore((s) => s.sendMessage);
  const askCopilot = useStore((s) => s.askCopilot);
  const kickstartVotes = useStore((s) => s.kickstartVotes);
  const merge = useStore((s) => s.merge);
  const workspace = useStore((s) => s.workspace);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [merging, setMerging] = useState(false);

  const [rightOpen, setRightOpen] = useState(true);
  const [tab, setTab] = useState<"copilot" | "files">("copilot");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  const thread = threads.find((t) => t.id === id);
  const memberMap: Map<string, (typeof members)[number]> = useMemo(
    () => new Map(members.map((m) => [m.id, m] as const)),
    [members]
  );
  const tMessages = messages.filter((m) => m.threadId === id);
  const tSteps = steps.filter((s) => s.threadId === id);
  const pendingDiffs = diffs.filter((d) => d.threadId === id && d.status === "pending");
  const allDiffs = diffs.filter((d) => d.threadId === id);
  const tMembers = thread ? members.filter((m) => thread.memberIds.includes(m.id)) : [];
  // The reader is always present on the thread they're viewing — count them
  // even when this session's member row isn't in thread.memberIds yet (a
  // share-code thread created by another device used to show "0 online").
  const viewer = members.find((m) => m.id === meId);
  const tRuns = Object.values(runs).filter((r) => r.threadId === id);
  const activeRun = tRuns.find((r) => !r.queued && ["queue", "plan", "write", "qa", "review"].includes(r.stage));
  const queuedRuns = tRuns.filter((r) => r.queued);
  // Only the MOST RECENT run decides the "agent not configured" banner — a
  // stale failed run must not keep claiming the agent is unconfigured after a
  // newer run succeeded (the misleading banner QA caught on KICK-90).
  const latestRun = [...tRuns].sort((a, b) => b.startedAt - a.startedAt)[0];
  const openFile = (p: string) => {
    setTab("files");
    setFilePath(p);
    setRightOpen(true);
  };

  // M3: merge gate state (threshold = majority of thread members, min 2)
  const teamCount = tMembers.length;
  const required = Math.max(2, Math.floor(teamCount / 2) + 1);
  const mergeable = pendingDiffs.length === 0 && allDiffs.length > 0 && allDiffs.every((d) => d.status === "approved") && allDiffs.every((d) => d.evidence?.qa?.verdict === "pass");
  const missingEvidence = allDiffs.some((d) => d.status === "approved" && d.evidence?.qa?.verdict !== "pass");

  useEffect(() => {
    kickstartVotes(id);
  }, [id, kickstartVotes]);

  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [tMessages.length, pendingDiffs.length, thread?.status]);

  if (!thread) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <p className="text-sm text-foreground/60">This thread doesn't exist anymore.</p>
        <Button variant="primary" onClick={onBack}>Back to workspace</Button>
      </div>
    );
  }

  const doMerge = async () => {
    setMerging(true);
    await merge(id);
    setMerging(false);
  };

  const doImport = async () => {
    if (!workspace?.repo || importing) return;
    setImporting(true); setImportMessage("");
    const result = await invokeGhImport(id);
    setImporting(false);
    setImportMessage(result.ok
      ? `Imported ${result.imported ?? 0} files${result.skipped ? `; skipped ${result.skipped}` : ""}.`
      : result.message ?? "Repository import failed.");
  };
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      askCopilot(id, text);
    } else {
      sendMessage(id, text);
    }
    setDraft("");
  };

  return (
    <div className="flex h-screen flex-col">
      {/* header */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/70 px-3 sm:px-4">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to workspace">
          <ArrowLeft size={15} />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-heading text-sm font-bold">{thread.name}</h1>
            <StatusPill status={thread.status} />
            <span className="hidden items-center gap-1.5 rounded-full border border-border px-2 py-0.5 sm:inline-flex">
              <span className="font-mono text-[10px] text-foreground/55">{thread.code}</span>
              <CopyButton text={thread.code} label="" />
            </span>
          </div>
          <p className="truncate text-[10.5px] text-foreground/45">{thread.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-[10.5px] text-foreground/50 sm:flex">
            <LiveDot />{" "}
            {tMembers.filter((m) => m.online).length + (viewer?.online && !tMembers.some((m) => m.id === meId) ? 1 : 0)} online
          </span>
          <AvatarStack members={tMembers} />
          {workspace?.repo && <Button variant="outline" size="sm" onClick={() => void doImport()} disabled={importing}><FolderOpen size={14} /> {importing ? "Importing…" : "Import repo"}</Button>}
          {importMessage && <span className="hidden max-w-40 truncate text-[10px] text-foreground/50 sm:inline" title={importMessage}>{importMessage}</span>}
          <Button variant={rightOpen ? "outline" : "ghost"} size="sm" onClick={() => setRightOpen(!rightOpen)} aria-label="Toggle copilot panel">
            <PanelRight size={15} />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* left rail */}
        <aside className="hidden w-60 shrink-0 flex-col gap-3 overflow-y-auto scroll-thin border-r border-border/70 bg-canvas/40 p-3 lg:flex">
          <StatusRail status={thread.status} />
          <StepsPanel threadId={id} steps={tSteps} members={memberMap} />
          <div className="rounded-xl border border-border bg-panel p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-foreground/45">Diffs</span>
              {pendingDiffs.length > 0 && (
                <span className="rounded-full bg-warning/12 px-1.5 py-0.5 text-[9px] font-bold text-warning">{pendingDiffs.length} pending</span>
              )}
            </div>
            {allDiffs.length === 0 ? (
              <p className="text-[11px] text-foreground/45">No diffs yet. The agent will drop its work here for the team to review.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {allDiffs.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-1.5 rounded-lg px-1.5 py-1 text-[10.5px]">
                    <button className="min-w-0 cursor-pointer truncate font-mono text-left hover:text-accent" onClick={() => openFile(d.path)} title={d.path}>
                      {d.path}
                    </button>
                    <span className={cn("shrink-0", d.status === "pending" ? "text-warning" : d.status === "approved" ? "text-success" : "text-destructive")}>
                      {d.status === "pending" ? "◦" : d.status === "approved" ? "✓" : "✕"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* center: feed */}
        <section className="flex min-w-0 flex-1 flex-col">
          {activeRun && (
            <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-agent/8 px-4 py-1.5">
              <span className="flex items-center gap-2 text-[11px] text-agent">
                <span className="pulse-dot relative h-2 w-2 rounded-full bg-agent" />
                Agent run {activeRun.stage === "queue" ? "queued" : activeRun.stage.replace("_", " ")} — {activeRun.prompt.slice(0, 60)}
              </span>
              {queuedRuns.length > 0 && (
                <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-foreground/55">
                  {queuedRuns.length} queued
                </span>
              )}
            </div>
          )}
          {latestRun?.notConfigured && (
            <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-warning/8 px-4 py-1.5">
              <span className="flex items-center gap-1.5 text-[11px] text-warning">
                <Bot size={13} /> Agent not configured — add an LLM key in Supabase Edge Function secrets to enable real runs.
              </span>
            </div>
          )}
          {pendingDiffs.length > 0 && (
            <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-warning/8 px-4 py-1.5">
              <span className="text-[11px] text-warning">
                {pendingDiffs.length} diff{pendingDiffs.length > 1 ? "s" : ""} waiting on the team — reviewers, run the approvals.
              </span>
              <Button variant="primary" size="sm" onClick={() => pendingDiffs.forEach((d) => useStore.getState().vote(d.id, "approve"))}>
                approve all
              </Button>
            </div>
          )}
          {!pendingDiffs.length && mergeable && thread.status !== "shipped" && (
            <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-success/8 px-4 py-1.5">
              <span className="flex items-center gap-1.5 text-[11px] text-success">
                <ShieldCheck size={13} /> Approval gate passed — evidence attached, threshold met.
              </span>
              <Button variant="primary" size="sm" onClick={() => void doMerge()} disabled={merging}>
                {merging ? "Merging…" : "Merge to ship"}
              </Button>
            </div>
          )}
          {thread.status === "shipped" && allDiffs.length > 0 && (
            <div className="flex items-center gap-2 border-b border-border/40 bg-success/8 px-4 py-1.5">
              <span className="flex items-center gap-1.5 text-[11px] text-success">
                <Check size={13} /> Shipped & merged — the approved diffs on this thread landed on the repo.
              </span>
            </div>
          )}
          {!pendingDiffs.length && allDiffs.length > 0 && !mergeable && thread.status === "review" && (
            <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-foreground/5 px-4 py-1.5">
              <span className="text-[11px] text-foreground/55">
                {missingEvidence ? "Merge locked — evidence missing on an approved diff." : `Merge locked — needs ${required} approvals and evidence on every diff.`}
              </span>
            </div>
          )}
          <div ref={feedRef} className="scroll-thin flex-1 overflow-y-auto px-4 py-4">
            {tMessages.length === 0 ? (
              <div className="mx-auto mt-16 max-w-sm">
                <EmptyState
                  icon={<MessageSquare size={22} />}
                  title="This thread is fresh"
                  hint="Say hi to the team — or type /plan <feature> and watch the agent take the harness."
                />
              </div>
            ) : (
              <div className="mx-auto flex max-w-2xl flex-col gap-3">
                {tMessages.map((m) => (
                  <Message key={m.id} m={m} meId={meId} members={memberMap} diffs={allDiffs} onOpenFile={openFile} />
                ))}
              </div>
            )}
          </div>

          {/* composer */}
          <div className="shrink-0 border-t border-border/70 bg-canvas/60 p-3">
            <div className="mx-auto flex max-w-2xl items-end gap-2">
              <label htmlFor="composer" className="sr-only">
                Message the team, or type a slash command for the agent
              </label>
              <textarea
                id="composer"
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder={
                  pendingDiffs.length > 0
                    ? "Message the team, or approve the diffs above…"
                    : "Message the team — try /fix, /plan, /review…"
                }
                className="max-h-32 min-h-10 flex-1 resize-none rounded-xl border border-border bg-canvas px-3.5 py-2.5 text-[12.5px] placeholder:text-foreground/30 focus:border-foreground/40 focus:outline-none"
              />
              <Button variant="primary" onClick={submit} aria-label="Send">
                <Send size={14} />
              </Button>
            </div>
            <div className="mx-auto mt-2 flex max-w-2xl flex-wrap items-center gap-1.5">
              <span className="mr-1 flex items-center gap-1 text-[10px] text-foreground/45">
                <Sparkles size={11} className="text-accent" /> Agent:
              </span>
              {[
                ["/plan a feature", "/plan build the checkout flow"],
                ["/fix the duplicate charge", "/fix duplicate charge on retry"],
                ["/review", "/review"],
                ["/summary", "/summary"],
              ].map(([label, val]) => (
                <button
                  key={label}
                  onClick={() => askCopilot(id, val)}
                  className="cursor-pointer rounded-full border border-border bg-panel px-2.5 py-1 text-[10.5px] text-foreground/65 transition hover:border-accent/40 hover:text-accent"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* right panel */}
        <aside
          className={cn(
            "w-[300px] shrink-0 flex-col border-l border-border/70 bg-canvas/40",
            rightOpen ? "hidden md:flex" : "hidden"
          )}
        >
          <div className="flex items-center gap-1 border-b border-border/70 p-2">
            {(["copilot", "files"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                aria-selected={tab === t}
                role="tab"
                className={cn(
                  "cursor-pointer rounded-lg px-3 py-1.5 text-[11px] font-semibold capitalize transition",
                  tab === t ? "bg-accent/15 text-accent" : "text-foreground/55 hover:bg-muted"
                )}
              >
                {t}
              </button>
            ))}
            <span className="ml-auto flex items-center gap-1 text-[10px] text-foreground/40">
              <LiveDot /> live
            </span>
          </div>
          {tab === "copilot" ? (
            <CopilotPanel threadId={id} />
          ) : (
            <FilesPanel files={files[id] ?? []} filePath={filePath} onSelect={setFilePath} />
          )}
        </aside>
      </div>
    </div>
  );
}

/* ================= copilot ================= */
function CopilotPanel({ threadId }: { threadId: string }) {
  const askCopilot = useStore((s) => s.askCopilot);
  const copilot = useStore((s) => s.copilot[threadId]) ?? EMPTY_COPILOT;
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const feed = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [copilot.length, thinking]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setThinking(true);
    window.setTimeout(() => setThinking(false), 900);
    askCopilot(threadId, t);
    setText("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={feed} className="scroll-thin flex-1 overflow-y-auto px-3 py-3">
        {copilot.length === 0 && (
          <p className="mt-4 px-1 text-center text-[11px] leading-relaxed text-foreground/45">
            Thread copilot — ask anything about this line of work.
            <br />
            Try <span className="text-accent">/summary</span>, <span className="text-accent">/review</span>, <span className="text-accent">/plan</span>.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {copilot.map((m) => (
            <div key={m.id} className={cn("whitespace-pre-wrap rounded-xl px-3 py-2 text-[11.5px] leading-relaxed", m.role === "user" ? "self-end bg-primary text-on-primary" : "self-start border border-border bg-panel text-foreground/85")}>
              {m.text}
            </div>
          ))}
          {thinking && (
            <div className="self-start flex items-center gap-1 rounded-xl border border-border bg-panel px-3 py-2 text-foreground/60">
              <span className="typing"><i /><i /><i /></span>
            </div>
          )}
        </div>
      </div>
      <div className="border-t border-border/70 p-2.5">
        <div className="mb-2 flex flex-wrap gap-1">
          {["/summary", "/steps", "/blockers", "/review", "/plan feature", "/fix bug"].map((c) => (
            <button
              key={c}
              onClick={() => { setText(c); }}
              className="cursor-pointer rounded-full border border-border bg-panel px-2 py-0.5 text-[9.5px] text-foreground/60 transition hover:border-accent/40 hover:text-accent"
            >
              {c}
            </button>
          ))}
        </div>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="copilot-input" className="sr-only">
            Ask the copilot
          </label>
          <input
            id="copilot-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Ask the copilot…"
            className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-canvas px-2.5 text-[11.5px] placeholder:text-foreground/30 focus:border-accent/40 focus:outline-none"
          />
          <Button variant="primary" size="sm" type="submit" aria-label="Ask">
            <Send size={13} />
          </Button>
        </form>
      </div>
    </div>
  );
}

/* ================= files ================= */
function FilesPanel({
  files,
  filePath,
  onSelect,
}: {
  files: RepoFile[];
  filePath: string | null;
  onSelect: (p: string | null) => void;
}) {
  const open = files.find((f) => f.path === filePath);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-foreground/45">Harness repo</div>
      <div className="scroll-thin flex-1 overflow-y-auto px-2 pb-3">
        {files.length === 0 && (
          <p className="px-2 text-[11px] text-foreground/45">No repo files on this thread yet.</p>
        )}
        {files.map((f) => {
          const path = f.path;
          const isDir = path.includes("/");
          return (
            <button
              key={path}
              onClick={() => onSelect(path)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] transition",
                filePath === path ? "bg-accent/12 text-accent" : "text-foreground/70 hover:bg-muted"
              )}
            >
              {isDir ? <FolderOpen size={12} className="shrink-0 text-foreground/45" /> : <FileCode2 size={12} className="shrink-0 text-success/80" />}
              <span className="truncate font-mono">{path}</span>
            </button>
          );
        })}
      </div>
      {open && (
        <div className="scroll-thin max-h-[45%] overflow-y-auto border-t border-border/70 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="truncate font-mono text-[11px] text-foreground/80">{open.path}</span>
            <button onClick={() => onSelect(null)} className="cursor-pointer text-foreground/45 hover:text-foreground" aria-label="Close file">
              <X size={13} />
            </button>
          </div>
          <pre className="code-block scroll-thin max-h-72 overflow-auto p-3 text-[10.5px] leading-relaxed text-foreground/80">
            {open.content.split("\n").map((l, i) => (
              <div key={i} className="flex">
                <span className="mr-3 w-6 select-none text-right text-foreground/25">{i + 1}</span>
                <span className="whitespace-pre">{l}</span>
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}