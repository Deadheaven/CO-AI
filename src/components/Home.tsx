import { useState } from "react";
import { ArrowRight, Bot, Code2, FileDiff, ListChecks, Pencil, Plus, RefreshCw, Terminal, Users } from "lucide-react";
import { Avatar, AvatarStack, Button, CopyButton, EmptyState, Field, LiveDot, Modal, cn, inputCls } from "./ui";
import { useStore, isLive } from "../store";
import { COLORS, updateWorkspaceSettings } from "../lib/api";
import { fmtTime } from "../lib/engine";

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-accent/40 bg-accent/10 text-accent">
      <Terminal size={size} />
    </span>
  );
}

export default function Home({
  onOpen,
}: {
  onOpen: (threadId: string) => void;
}) {
  const threads = useStore((s) => s.threads);
  const members = useStore((s) => s.members);
  const diffs = useStore((s) => s.diffs);
  const meId = useStore((s) => s.meId);
  const simOn = useStore((s) => s.simOn);
  const setSim = useStore((s) => s.setSim);
  const resetDemo = useStore((s) => s.resetDemo);
  const createThread = useStore((s) => s.createThread);
  const joinThread = useStore((s) => s.joinThread);
  const updateMe = useStore((s) => s.updateMe);
  const workspace = useStore((s) => s.workspace);
  const setWorkspace = useStore((s) => s.setWorkspace);

  const live = isLive();

  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [verificationCommand, setVerificationCommand] = useState("");
  const [verificationCwd, setVerificationCwd] = useState("/workspace");
  const [verificationError, setVerificationError] = useState("");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [code, setCode] = useState("");
  const [joinError, setJoinError] = useState("");
  const [createError, setCreateError] = useState("");
  const [meName, setMeName] = useState("");
  const [meColor, setMeColor] = useState(COLORS[0]);

  const onlineCount = members.filter((m) => m.online).length;
  const pendingCount = diffs.filter((d) => d.status === "pending").length;
  const me = members.find((m) => m.id === meId);

  const doCreate = async () => {
    if (!name.trim()) return;
    setCreateError("");
    try {
      const id = await createThread(name.trim(), desc.trim() || "A new line of work.");
      setCreateOpen(false);
      setName("");
      setDesc("");
      onOpen(id);
    } catch {
      setCreateError("We couldn't create that thread — try again.");
    }
  };

  const doJoin = async () => {
    const id = await joinThread(code);
    if (!id) {
      setJoinError("No thread with that code — check it and try again.");
      return;
    }
    setJoinOpen(false);
    setCode("");
    setJoinError("");
    onOpen(id);
  };

  const openProfile = () => {
    setMeName(me?.name ?? "You");
    setMeColor(me?.color ?? COLORS[0]);
    setProfileOpen(true);
  };

  const saveProfile = () => {
    updateMe(meName, meColor);
    setProfileOpen(false);
  };

  const openVerification = () => {
    setVerificationCommand(workspace?.verification?.command ?? "");
    setRepoOwner(workspace?.repo?.owner ?? "");
    setRepoName(workspace?.repo?.name ?? "");
    setBaseBranch(workspace?.repo?.baseBranch ?? "main");
    setVerificationCwd(workspace?.verification?.cwd ?? "/workspace");
    setVerificationError("");
    setVerificationOpen(true);
  };
  const saveVerification = async () => {
    const owner = repoOwner.trim(), name = repoName.trim(), branch = baseBranch.trim() || "main";
    if (!workspace || !verificationCommand.trim() || !verificationCwd.trim().startsWith("/") || (!!owner !== !!name)) { setVerificationError("Enter a command, absolute sandbox directory, and both repo owner/name or neither."); return; }

    const command = verificationCommand.trim(), cwd = verificationCwd.trim();
    if (!await updateWorkspaceSettings(workspace.id, {
      verificationCommand: command, verificationCwd: cwd,
      repoOwner: owner || null, repoName: name || null, baseBranch: branch,
    })) {
      setVerificationError("Could not save workspace settings."); return;
    }
    setWorkspace({ ...workspace, repo: owner ? { owner, name, baseBranch: branch } : null, verification: { command, cwd } });
    setVerificationOpen(false);
  };
  return (
    <div className="flex h-screen flex-col">
      {/* top bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/70 px-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Logo />
          <div>
            <div className="font-heading text-sm font-bold tracking-tight">CO-AI</div>
            <div className="text-[10px] uppercase tracking-widest text-foreground/45">
              collaborative agent workspace
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-2 rounded-full border border-border bg-panel px-3 py-1 text-[11px] text-foreground/70 sm:inline-flex">
            <LiveDot /> {onlineCount} online · {live ? "live workspace · synced" : simOn ? "simulated live engine" : "engine off"}
          </span>
          {live && <Button variant="outline" size="sm" onClick={openVerification} aria-label="Configure sandbox verification">
            <Terminal size={14} /> Verify
          </Button>}
          <Button variant="outline" size="sm" onClick={() => setJoinOpen(true)} aria-label="Join a thread by code">
            <Users size={14} /> Join
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)} aria-label="Create a new thread">
            <Plus size={14} /> New thread
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* left rail: threads */}
        <aside className="flex w-72 shrink-0 flex-col overflow-hidden border-r border-border/70 bg-canvas/40">
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <span className="text-[10px] font-bold uppercase tracking-widest text-foreground/45">Lines of work</span>
            {!live && (
              <button
                onClick={resetDemo}
                className="inline-flex cursor-pointer items-center gap-1 text-[10px] text-foreground/45 transition hover:text-foreground"
                aria-label="Reset demo data"
                title="Reset demo data"
              >
                <RefreshCw size={12} /> reset
              </button>
            )}
          </div>
          <nav className="flex flex-1 flex-col gap-1 px-2" aria-label="Threads">
            {threads.length === 0 && (
              <EmptyState icon={<ListChecks size={22} />} title="No threads yet" hint="Start a line of work — the agent will do the heavy lifting." />
            )}
            {threads.map((t) => {
              const tDiffs = diffs.filter((d) => d.threadId === t.id);
              const tPending = tDiffs.filter((d) => d.status === "pending").length;
              const tMembers = members.filter((m) => t.memberIds.includes(m.id));
              return (
                <button
                  key={t.id}
                  onClick={() => onOpen(t.id)}
                  className="group cursor-pointer rounded-xl border border-transparent px-3 py-2.5 text-left transition hover:border-border hover:bg-panel"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold">{t.name}</span>
                    <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", tPending > 0 ? "bg-warning/12 text-warning" : "bg-foreground/8 text-foreground/55")}>
                      {tPending > 0 ? `${tPending} review` : t.status}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-foreground/50">{t.description}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <AvatarStack members={tMembers} size={18} />
                    <span className="text-[10px] text-foreground/40">updated {fmtTime(t.ts)}</span>
                  </div>
                </button>
              );
            })}
          </nav>
          <div className="border-t border-border/70 p-3 text-[11px] text-foreground/45">
            <button
              onClick={openProfile}
              className="mb-1.5 flex w-full cursor-pointer items-center gap-2 text-left transition hover:opacity-80"
              aria-label="Edit your profile"
              title="Edit your profile"
            >
              <Avatar name={me?.name ?? "You"} color={me?.color ?? "#93c5fd"} size={20} online={me?.online} />
              <span className="font-semibold text-foreground/75">{me?.name ?? "You"}</span>
              <Pencil size={11} className="ml-auto text-foreground/35" />
            </button>
            <span className="text-foreground/40">
              {live ? "Your identity is stored on the shared workspace — teammates see it." : "You share one harness with your team — every thread is live."}
            </span>
          </div>
        </aside>

        {/* main */}
        <main className="flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto max-w-3xl px-6 py-10">
            <div className="rise">
              <h1 className="font-heading text-3xl font-bold leading-tight tracking-tight">
                One thread.
                <br />
                <span className="text-accent">Your team. An agent that ships.</span>
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-foreground/60">
                CO-AI is a harness thread: the place where your team and an AI agent
                work a single line of work together, live. The agent plans, writes code
                as reviewable diffs, QAs itself — and the whole team rides along, chats,
                and approves before anything ships.
              </p>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { icon: <ListChecks size={16} />, v: threads.length, l: "threads" },
                { icon: <FileDiff size={16} />, v: pendingCount, l: "diffs in review" },
                { icon: <Users size={16} />, v: onlineCount, l: "members online" },
                { icon: <Bot size={16} />, v: live ? "on" : "sim", l: "agent on harness" },
              ].map((c) => (
                <div key={c.l} className="rounded-xl border border-border bg-panel p-3">
                  <div className="flex items-center gap-2 text-accent">{c.icon}<span className="font-heading text-lg font-bold text-foreground">{c.v}</span></div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wider text-foreground/45">{c.l}</div>
                </div>
              ))}
            </div>

            <div className="mt-8">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-widest text-foreground/55">Your threads</h2>
                <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus size={14} /> Start a line of work
                </Button>
              </div>
              {threads.length === 0 ? (
                <EmptyState icon={<Code2 size={22} />} title="Nothing here yet" hint="Create a thread and the agent will start planning with you." />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {threads.map((t) => {
                    const tDiffs = diffs.filter((d) => d.threadId === t.id);
                    const tPending = tDiffs.filter((d) => d.status === "pending").length;
                    const tMembers = members.filter((m) => t.memberIds.includes(m.id));
                    return (
                      <button
                        key={t.id}
                        onClick={() => onOpen(t.id)}
                        className="rise group cursor-pointer rounded-2xl border border-border bg-panel p-4 text-left transition hover:-translate-y-0.5 hover:border-foreground/30 hover:shadow-lg hover:shadow-black/20"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-sm font-bold">{t.name}</span>
                          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-canvas px-2 py-0.5 font-mono text-[10px] text-foreground/55">{t.code}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 min-h-[2.4em] text-[11px] leading-relaxed text-foreground/55">{t.description}</p>
                        <div className="mt-3 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            {tPending > 0 ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[10px] font-semibold text-warning">
                                <FileDiff size={11} /> {tPending} diff{tPending > 1 ? "s" : ""} to review
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success">
                                <span className="relative flex h-1.5 w-1.5 rounded-full" /> in sync
                              </span>
                            )}
                          </div>
                          <ArrowRight size={15} className="text-foreground/35 transition group-hover:translate-x-0.5 group-hover:text-accent" />
                        </div>
                        <div className="mt-3 flex items-center justify-between border-t border-border/60 pt-2.5">
                          <AvatarStack members={tMembers} size={18} />
                          <span className="text-[10px] text-foreground/40">updated {fmtTime(t.ts)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-10 flex items-center gap-3 rounded-2xl border border-border bg-gradient-to-r from-panel to-canvas p-4">
              <Logo size={18} />
              <div className="flex-1">
                {live ? (
                  <>
                    <p className="text-xs font-semibold">Live workspace connected</p>
                    <p className="text-[11px] text-foreground/50">
                      Supabase is on — anonymous identity, threads, messages, diffs, and your profile persist and sync with your team. The real agent harness plugs in next.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-xs font-semibold">Simulated engine in preview</p>
                    <p className="text-[11px] text-foreground/50">
                      This preview runs the full product locally — the agent, teammates, and diffs are simulated so you can feel the loop. Connect Supabase and we switch to real-time sync + your own LLM.
                    </p>
                  </>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => setSim(!simOn)}>
                {simOn ? "pause sim" : "resume sim"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setJoinOpen(true)}>
                try a share code
              </Button>
            </div>
          </div>
        </main>
      </div>

      {/* Create modal */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Start a line of work">
        <div className="flex flex-col gap-3">
          <Field label="Thread name" htmlFor="thread-name">
            <input id="thread-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Add /refund endpoint" autoFocus />
          </Field>
          <Field label="Why it matters / description" htmlFor="thread-desc">
            <textarea id="thread-desc" rows={3} className={cn(inputCls, "h-auto resize-none py-2")} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Context your team and the agent will see." />
          </Field>
          {createError && <p className="text-[11px] text-destructive">{createError}</p>}
          <Button variant="primary" onClick={doCreate}>Create thread</Button>
        </div>
      </Modal>

      {/* Join modal */}
      <Modal open={joinOpen} onClose={() => setJoinOpen(false)} title="Join a thread">
        <div className="flex flex-col gap-3">
          <Field label="Share code" htmlFor="join-code">
            <input id="join-code" className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. DUP-9" autoFocus />
          </Field>
          {joinError && <p className="text-[11px] text-destructive">{joinError}</p>}
          <Button variant="primary" onClick={doJoin}>Join thread</Button>
          {!live && (
            <div className="flex items-center gap-2 text-[11px] text-foreground/45">
              <CopyButton text="DUP-9" label="copy demo code DUP-9" />
              <span>or try REF-01 / LOG-42</span>
            </div>
          )}
        </div>
      </Modal>

      {/* Profile modal */}
      <Modal open={profileOpen} onClose={() => setProfileOpen(false)} title="Your profile">
        <div className="flex flex-col gap-3">
          <Field label="Display name" htmlFor="me-name">
            <input id="me-name" className={inputCls} value={meName} onChange={(e) => setMeName(e.target.value)} maxLength={24} placeholder="How your team sees you" autoFocus />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground/60">Color</span>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Avatar color">
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setMeColor(c)}
                  role="radio"
                  aria-checked={meColor === c}
                  aria-label={`Color ${c}`}
                  className={cn(
                    "h-7 w-7 cursor-pointer rounded-full border-2 transition duration-150 active:scale-95",
                    meColor === c ? "border-foreground" : "border-transparent hover:border-foreground/40"
                  )}
                  style={{ background: c }}
                />
              ))}
            </div>
          </div>
          <Button variant="primary" onClick={saveProfile}>Save profile</Button>
        </div>
      </Modal>
      <Modal open={verificationOpen} onClose={() => setVerificationOpen(false)} title="Sandbox verification">
        <div className="flex flex-col gap-3">
          <Field label="GitHub owner" htmlFor="repo-owner">
            <input id="repo-owner" className={inputCls} value={repoOwner} onChange={(e) => setRepoOwner(e.target.value)} placeholder="octocat" />
          </Field>
          <Field label="GitHub repository" htmlFor="repo-name">
            <input id="repo-name" className={inputCls} value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="hello-world" />
          </Field>
          <Field label="Base branch" htmlFor="base-branch">
            <input id="base-branch" className={inputCls} value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} placeholder="main" />
          </Field>
          <Field label="Verification command" htmlFor="verification-command">
            <input id="verification-command" className={inputCls} value={verificationCommand} onChange={(e) => setVerificationCommand(e.target.value)} placeholder="npm test" autoFocus />
          </Field>
          <Field label="Sandbox working directory" htmlFor="verification-cwd">
            <input id="verification-cwd" className={inputCls} value={verificationCwd} onChange={(e) => setVerificationCwd(e.target.value)} placeholder="/workspace" />
          </Field>
          <p className="text-[11px] leading-relaxed text-foreground/50">CO-AI runs this command in a disposable, network-disabled sandbox against the proposed revision.</p>
          {verificationError && <p className="text-[11px] text-destructive">{verificationError}</p>}
          <Button variant="primary" onClick={saveVerification}>Save verification command</Button>
        </div>
      </Modal>
    </div>
  );
}