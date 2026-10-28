import { CONSULT_KINDS, type ConsultKind, type ConsultOutcome, type ConsultRequest } from "./types.js";

/** What the agent gets back from a consult, wherever the consult ran. */
export interface ConsultReply {
  ok: boolean;
  text: string;
  outcome: ConsultOutcome;
  recordId: string;
}

export interface ConsultHandler {
  handle(request: ConsultRequest, signal?: AbortSignal): Promise<ConsultReply>;
}

export class ConsultRequestError extends Error {
  override name = "ConsultRequestError";
}

const MAX_PROBLEM_CHARS = 100_000;
const MAX_FILES = 50;

/** Validates a consult request arriving from the sandboxed agent (untrusted input). */
export function parseConsultRequest(body: unknown): ConsultRequest {
  if (typeof body !== "object" || body === null) throw new ConsultRequestError("consult request must be an object");
  const b = body as Record<string, unknown>;
  if (typeof b.kind !== "string" || !(CONSULT_KINDS as readonly string[]).includes(b.kind)) throw new ConsultRequestError(`unknown consult kind ${String(b.kind)}`);
  if (typeof b.problem !== "string" || !b.problem.trim()) throw new ConsultRequestError("consult problem is missing");
  if (b.problem.length > MAX_PROBLEM_CHARS) throw new ConsultRequestError("consult problem is too long");
  const files = b.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_FILES || !files.every((f) => typeof f === "string")) throw new ConsultRequestError("consult files must be a list of paths");
  if (b.attempts !== undefined && typeof b.attempts !== "string") throw new ConsultRequestError("consult attempts must be text");
  return { kind: b.kind as ConsultKind, problem: b.problem, files: files as string[], ...(b.attempts ? { attempts: b.attempts as string } : {}) };
}

/** The sandboxed agent's side: consults run in the gateway, outside the sandbox. */
export function remoteConsultHandler(opts: { gatewayUrl: string; token: string; fetch?: typeof fetch }): ConsultHandler {
  const doFetch = opts.fetch ?? fetch;
  return {
    async handle(request, signal) {
      const res = await doFetch(`${opts.gatewayUrl}/v1/consult`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<ConsultReply> & { error?: string };
      if (!res.ok) return { ok: false, text: `The consult could not be made: ${body.error ?? `gateway answered ${res.status}`}. Continue on your own.`, outcome: "error", recordId: "" };
      return { ok: body.ok === true, text: String(body.text ?? ""), outcome: (body.outcome ?? "error") as ConsultOutcome, recordId: String(body.recordId ?? "") };
    },
  };
}
