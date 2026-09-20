export type MemberId = string;

export interface Member {
  id: MemberId;
  name: string;
  color: string;
  isBot?: boolean;
  online: boolean;
}

/** A live presence row for one member (member_id from the presence table). */
export interface PresenceInfo {
  memberId: string;
  name: string;
  color: string;
  online: boolean;
  lastSeen: number;
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

/** Evidence attached to a diff (M3): the agent's self-QA report + test/lint output. */
export interface QaCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface QaReport {
  summary: string;
  verdict: "pass" | "fail";
  checks: QaCheck[];
}

export interface TestEvidence {
  command: string;
  passed: boolean;
  output: string;
}

export interface Evidence {
  qa: QaReport;
  tests?: TestEvidence;
}

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
  evidence?: Evidence;
  /** `unverified` is model-authored/static output, never executable proof. */
  evidenceSource?: "unverified" | "executor";
  merged?: boolean;
  prNumber?: number;
  branch?: string;
}

/** Approval policy (PRD §11): configurable threshold, default majority with min 2. */
export interface ApprovalPolicy {
  mode: "majority" | "all";
  min: number;
}

export const DEFAULT_POLICY: ApprovalPolicy = { mode: "majority", min: 2 };

export interface Thread {
  id: string;
  name: string;
  code: string;
  description: string;
  status: ThreadStatus;
  memberIds: string[];
  ts: number;
}

/** Workspace-level settings (M3 #6 + GitHub connector). Single shared row per team. */
export interface WorkspaceSettings {
  id: string;
  /** Approval policy from workspaces.approval_threshold (default majority min 2). */
  approvalThreshold: ApprovalPolicy;
  /** Connected GitHub repo, or null when not connected (demo merges in place). */
  repo: { owner: string; name: string; baseBranch: string } | null;
}

export type RunStage = "queue" | "plan" | "write" | "qa" | "review" | "done" | "blocked";

export interface AgentRun {
  id: string;
  threadId: string;
  prompt: string;
  stage: RunStage;
  log: string[];
  startedAt: number;
  finishedAt?: number;
  /** What kicked the run off: "chat", "slash", "reject-fix", "copilot". */
  trigger?: string;
  /** When the LLM key is missing / the function is unreachable. */
  notConfigured?: boolean;
  /** Run queue: runs beyond the active one wait here (one active run per thread). */
  queued?: boolean;
}

export interface CopilotMsg {
  id: string;
  role: "user" | "ai";
  text: string;
  ts: number;
}
