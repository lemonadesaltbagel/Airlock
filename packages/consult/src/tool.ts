import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ConsultHandler, ConsultReply } from "./remote.js";
import type { ConsultToolResult } from "./service.js";
import { CONSULT_KINDS, type ConsultKind, type ConsultRequest } from "./types.js";

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

/** Anything that runs consults: the in-process service, or the gateway through a remote handler. */
export interface ConsultRunner {
  handle(request: ConsultRequest, signal?: AbortSignal): Promise<ConsultToolResult | ConsultReply>;
}

export function toReply(result: ConsultToolResult | ConsultReply): ConsultReply {
  return "record" in result ? { ok: result.ok, text: result.text, outcome: result.record.outcome, recordId: result.record.id } : result;
}

export function serviceHandler(service: ConsultRunner): ConsultHandler {
  return { handle: async (request, signal) => toReply(await service.handle(request, signal)) };
}

export function consultTool(service: ConsultRunner): AgentTool<typeof consultParams, ConsultToolDetails> {
  return {
    name: "consult_expert",
    label: "Consult expert",
    description:
      "Ask an outside expert for help with a hard technical problem: a bug you cannot diagnose, a tricky algorithm or concurrency issue, an API you are unsure about, or a design trade-off. The question is rewritten so it reveals nothing about this project before it is sent, so the expert never sees your code. Use it sparingly, after investigating yourself; easy questions should be solved locally.",
    parameters: consultParams,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const result = toReply(
        await service.handle(
        { kind: params.kind as ConsultKind, problem: params.problem, files: params.files ?? [], ...(params.attempts ? { attempts: params.attempts } : {}) },
          signal,
        ),
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: { ok: result.ok, outcome: result.outcome, recordId: result.recordId },
        isError: !result.ok,
      };
    },
  };
}
