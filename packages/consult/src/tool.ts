import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ConsultService } from "./service.js";
import { CONSULT_KINDS, type ConsultKind } from "./types.js";

const consultParams = Type.Object({
  kind: Type.Union(
    CONSULT_KINDS.map((k) => Type.Literal(k)),
    { description: "What kind of help you need." },
  ),
  problem: Type.String({
    description:
      "The problem in full: expected vs actual behaviour, error messages, the relevant logic. Write it for a local helper who will rephrase it — include project details; they are removed before anything leaves.",
  }),
  files: Type.Optional(Type.Array(Type.String(), { description: "Workspace-relative paths of the files that matter." })),
  attempts: Type.Optional(Type.String({ description: "What you already tried and what happened." })),
});

export interface ConsultToolDetails {
  ok: boolean;
  outcome: string;
  recordId: string;
}

export function consultTool(service: ConsultService): AgentTool<typeof consultParams, ConsultToolDetails> {
  return {
    name: "consult_expert",
    label: "Consult expert",
    description:
      "Ask an outside expert for help with a hard technical problem: a bug you cannot diagnose, a tricky algorithm or concurrency issue, an API you are unsure about, or a design trade-off. The question is rewritten so it reveals nothing about this project before it is sent, so the expert never sees your code. Use it sparingly, after investigating yourself; easy questions should be solved locally.",
    parameters: consultParams,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const result = await service.handle(
        { kind: params.kind as ConsultKind, problem: params.problem, files: params.files ?? [], ...(params.attempts ? { attempts: params.attempts } : {}) },
        signal,
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: { ok: result.ok, outcome: result.record.outcome, recordId: result.record.id },
        isError: !result.ok,
      };
    },
  };
}
