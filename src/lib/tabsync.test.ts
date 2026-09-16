import { describe, expect, it } from "vitest";
import { decodeTabSnapshot, mergeTabSnapshot, type TabSnapshot } from "./tabsync";
import type { AgentRun, ChatMsg, Diff, Member, RepoFile, Step, Thread } from "../types";

const mkThread = (id: string, status: Thread["status"] = "draft", ts = 100): Thread => ({
  id,
  name: `Thread ${id}`,
  code: "T-1",
  description: "",
  status,
  memberIds: ["me"],
  ts,
});

const mkMsg = (id: string, threadId = "t1", ts = id.length, body = "hi"): ChatMsg => ({
  id,
  threadId,
  authorId: "me",
  kind: "chat",
  body,
  ts,
});

const mkStep = (id: string): Step => ({ id, threadId: "t1", title: `step ${id}`, status: "todo" });

const mkDiff = (id: string): Diff => ({
  id,
  threadId: "t1",
  runId: "r1",
  path: `src/${id}.ts`,
  label: `add ${id}`,
  before: "",
  after: "export {}",
  status: "pending",
  votes: {},
});

const mkRun = (id: string, stage: AgentRun["stage"] = "plan"): AgentRun => ({
  id,
  threadId: "t1",
  prompt: "p",
  stage,
  log: [],
  startedAt: 0,
});

const mkFile = (path: string, content = "1"): RepoFile => ({ path, content });

const mkMember = (id: string, name = "M", color = "#111"): Member => ({ id, name, color, online: true });

const base = (): TabSnapshot => ({
  threads: [mkThread("t1")],
  messages: [mkMsg("m1")],
  steps: [mkStep("s1")],
  diffs: [mkDiff("d1")],
  runs: { r1: mkRun("r1", "plan") },
  files: { t1: [mkFile("src/a.ts")] },
  members: [mkMember("me")],
  copilot: {},
});

describe("mergeTabSnapshot (demo cross-tab sync)", () => {
  it("delivers a message written in another tab (union, ts-ascending)", () => {
    const cur = base();
    const incoming = base();
    incoming.messages.push(mkMsg("m2", "t1", 200));
    const { next, changed } = mergeTabSnapshot(cur, incoming);
    expect(changed).toBe(true);
    expect(next.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(next.messages[1]!.body).toBe("hi");
  });

  it("incoming wins on id conflicts (newest writer authoritative)", () => {
    const cur = base();
    const incoming = base();
    incoming.threads[0] = mkThread("t1", "shipped", 500);
    const { next } = mergeTabSnapshot(cur, incoming);
    expect(next.threads[0]!.status).toBe("shipped");
  });

  it("runs merge per run id with incoming winning", () => {
    const cur = base();
    const incoming = base();
    incoming.runs.r1 = mkRun("r1", "review");
    incoming.runs.r2 = mkRun("r2", "qa");
    const { next, changed } = mergeTabSnapshot(cur, incoming);
    expect(changed).toBe(true);
    expect(next.runs.r1!.stage).toBe("review");
    expect(next.runs.r2!.stage).toBe("qa");
  });

  it("files merge per thread by path, incoming wins on edit", () => {
    const cur = base();
    const incoming = base();
    incoming.files.t1 = [mkFile("src/a.ts", "2"), mkFile("src/b.ts", "1")];
    const { next, changed } = mergeTabSnapshot(cur, incoming);
    expect(changed).toBe(true);
    expect(next.files.t1).toHaveLength(2);
    expect(next.files.t1!.find((f) => f.path === "src/a.ts")!.content).toBe("2");
  });

  it("profile edits (name/color) propagate to the other tab", () => {
    const cur = base();
    const incoming = base();
    incoming.members[0] = mkMember("me", "Team Lead", "#f0abfc");
    const { next, changed } = mergeTabSnapshot(cur, incoming);
    expect(changed).toBe(true);
    expect(next.members[0]!.name).toBe("Team Lead");
    expect(next.members[0]!.color).toBe("#f0abfc");
  });

  it("threads sort most-recent-first after a merge", () => {
    const cur = base(); // t1 ts=100
    const incoming = base();
    incoming.threads = [mkThread("t1", "review", 400), mkThread("t2", "draft", 300)];
    const { next } = mergeTabSnapshot(cur, incoming);
    expect(next.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("no change → changed=false (prevents storage ping-pong between tabs)", () => {
    const cur = base();
    const incoming = base();
    const { changed } = mergeTabSnapshot(cur, incoming);
    expect(changed).toBe(false);
  });

  it("steps and diffs merge by id without dropping either side", () => {
    const cur = base();
    const incoming = base();
    incoming.steps.push(mkStep("s2"));
    incoming.diffs.push(mkDiff("d2"));
    const { next, changed } = mergeTabSnapshot(cur, incoming);
    expect(changed).toBe(true);
    expect(next.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(next.diffs.map((d) => d.id)).toEqual(["d1", "d2"]);
  });
});

describe("decodeTabSnapshot (zustand persist envelope)", () => {
  it("unwraps a persisted `{ state, version }` envelope into the snapshot", () => {
    const snap = base();
    const decoded = decodeTabSnapshot(JSON.parse(JSON.stringify({ state: snap, version: 1 })));
    expect(decoded).not.toBeNull();
    expect(decoded!.threads!.map((t) => t.id)).toEqual(["t1"]);
    expect(decoded!.messages!.map((m) => m.id)).toEqual(["m1"]);
    expect(decoded!.members![0]!.name).toBe("M");
  });

  it("passes a raw snapshot through untouched (manual writes / tests)", () => {
    const snap = base();
    const decoded = decodeTabSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(decoded?.threads![0]!.id).toBe("t1");
    expect(decoded?.messages![0]!.id).toBe("m1");
  });

  it("rejects null, non-objects, and payloads with no tab-sync slices", () => {
    expect(decodeTabSnapshot(null)).toBeNull();
    expect(decodeTabSnapshot("nope")).toBeNull();
    expect(decodeTabSnapshot(42)).toBeNull();
    expect(decodeTabSnapshot({})).toBeNull();
    expect(decodeTabSnapshot({ state: {}, version: 1 })).toBeNull();
    expect(decodeTabSnapshot({ hello: "world" })).toBeNull();
  });

  it("regression: a message persisted in one tab delivers into the other tab's store", () => {
    const receiving = base();
    const inbound = base();
    inbound.messages.push(mkMsg("m2", "t1", 200, "QC-ping"));
    const fromTab = decodeTabSnapshot(JSON.parse(JSON.stringify({ state: inbound, version: 1 })))!;
    const { next, changed } = mergeTabSnapshot(receiving, fromTab);
    expect(changed).toBe(true);
    expect(next.messages.some((m) => m.body === "QC-ping")).toBe(true);
    expect(next.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
  });
});