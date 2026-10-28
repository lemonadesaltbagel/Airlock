/** What the gateway tells the sandboxed agent process at start (GET /v1/session). */
export interface AgentSession {
  task: string;
  profile: string;
  role: "loop" | "quality";
  consult: boolean;
  workspaceRoot: string;
}

export const GATEWAY_URL_ENV = "AIRLOCK_GATEWAY_URL";
export const GATEWAY_TOKEN_ENV = "AIRLOCK_GATEWAY_TOKEN";
