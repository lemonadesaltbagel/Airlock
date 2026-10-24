import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}
