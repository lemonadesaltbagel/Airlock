import type { Usage } from "@earendil-works/pi-ai";

/** Each kind fixes what a consult is for; later milestones attach content-level policy to it. */
export const CONSULT_KINDS = [
  "bug-diagnosis",
  "algorithm",
  "concurrency",
  "api-usage",
  "design-tradeoff",
  "review",
  "world-knowledge",
] as const;
export type ConsultKind = (typeof CONSULT_KINDS)[number];

/** What the local agent asks for. Stays on the machine. */
export interface ConsultRequest {
  kind: ConsultKind;
  /** The problem in the agent's own words, with full project context. */
  problem: string;
  /** Workspace-relative files relevant to the problem. */
  files: string[];
  /** What the agent already tried and what happened. */
  attempts?: string;
}

/** What leaves the machine: a self-contained question with no project specifics. */
export interface ConsultPacket {
  kind: ConsultKind;
  title: string;
  question: string;
  code?: string;
  language?: string;
  constraints?: string[];
}

export type GateRule = "secret" | "jewel-term" | "jewel-fragment" | "repo-fragment" | "identifier" | "literal";

export interface GateFinding {
  rule: GateRule;
  /** The offending text as found in the outbound message. */
  match: string;
  detail: string;
}

export type ConsultOutcome = "sent" | "blocked" | "declined" | "refused" | "error" | "budget-exhausted";

export interface ConsultRecord {
  id: string;
  timestamp: string;
  mode: "naive" | "abstracted";
  sessionId?: string;
  taskId?: string;
  /** Local-only: the agent's request. Never sent. */
  request: ConsultRequest;
  /** Exactly the text that was (or would have been) sent. */
  outbound?: string;
  packet?: ConsultPacket;
  findings: GateFinding[];
  /** The request referenced a declared crown-jewel file. */
  touchesJewels?: boolean;
  outcome: ConsultOutcome;
  consultantModel?: string;
  response?: string;
  errorMessage?: string;
  /** Usage of the consultant call. Abstraction calls are reported separately. */
  usage?: Usage;
  abstractionUsage?: Usage[];
  abstractionAttempts?: number;
}
