export type MemberId = string;

export interface Member {
  id: MemberId;
  name: string;
  color: string;
  isBot?: boolean;
  online: boolean;
}

export type ThreadStatus =
  | "draft"
  | "planning"
  | "in_progress"
  | "review"
  | "shipped"
  | "blocked";

export type MsgKind = "chat" | "agent" | "system" | "diff" | "copilot";

export interface ChatMsg {
  id: string;
  threadId: string;
  authorId: string;
  kind: MsgKind;
  body?: string;
  runId?: string;
  diffId?: string;
  parentId?: string;
  meta?: string;
  ts: number;
}

export type StepStatus = "todo" | "active" | "done";

export interface Step {
  id: string;
  threadId: string;
  title: string;
  status: StepStatus;
  ownerId?: string;
}

export interface RepoFile {
  path: string;
  content: string;
}

export type Vote = "approve" | "reject";
export type DiffStatus = "pending" | "approved" | "rejected";

export interface Diff {
  id: string;
  threadId: string;
  runId: string;
  path: string;
  label: string;
  before: string;
  after: string;
  status: DiffStatus;
  votes: Record<string, Vote>;
  comment?: string;
}

export interface Thread {
  id: string;
  name: string;
  code: string;
  description: string;
  status: ThreadStatus;
  memberIds: string[];
  ts: number;
}

export type RunStage = "queue" | "plan" | "write" | "qa" | "review" | "done";

export interface AgentRun {
  id: string;
  threadId: string;
  prompt: string;
  stage: RunStage;
  log: string[];
  startedAt: number;
}

export interface CopilotMsg {
  id: string;
  role: "user" | "ai";
  text: string;
  ts: number;
}