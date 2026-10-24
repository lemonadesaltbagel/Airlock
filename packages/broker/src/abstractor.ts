import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Workspace } from "@airlock/agent";
import type { AbstractionResult, Abstractor, ConsultPacket, ConsultRequest, Gate, GateFinding } from "@airlock/consult";
import { renderPacket } from "@airlock/consult";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, Type, type Api, type Message, type Model, type Models, type Usage } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { extractJsonObject } from "./json.js";
import { ABSTRACTION_SYSTEM_PROMPT, DEFAULT_PUBLIC_PROFILE, renderAbstractionRequest, renderRewriteRequest } from "./prompts.js";

export const PUBLIC_PROFILE_FILE = ".airlock/profile.md";

const MAX_FILE_CHARS = 30_000;
const MAX_TOTAL_FILE_CHARS = 90_000;

const TRANSIENT = /connection|terminated|timed? ?out|ECONNRESET|ETIMEDOUT|socket|fetch failed|overloaded|rate.?limit|\b429\b|\b5\d\d\b/i;

const ResponseSchema = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("cannot_abstract")]),
  reason: Type.Optional(Type.String()),
  crux: Type.Optional(Type.String()),
  removed: Type.Optional(Type.Array(Type.String())),
  packet: Type.Optional(
    Type.Object({
      title: Type.String({ minLength: 1 }),
      question: Type.String({ minLength: 1 }),
      code: Type.Optional(Type.String()),
      language: Type.Optional(Type.String()),
      constraints: Type.Optional(Type.Array(Type.String())),
    }),
  ),
});

export interface AbstractorOptions {
  models: Models;
  /** The local "quality" model. In dev-cloud this is a cloud stand-in. */
  model: Model<Api>;
  thinking?: ThinkingLevel;
  workspace: Workspace;
  gate: Gate;
  /** Rewrite rounds after gate findings. Default 2. */
  maxRewrites?: number;
  /** Replaces ABSTRACTION_SYSTEM_PROMPT; used to A/B-test prompt variants. */
  systemPrompt?: string;
}

export async function loadPublicProfile(ws: Workspace): Promise<string> {
  const path = join(ws.root, PUBLIC_PROFILE_FILE);
  return existsSync(path) ? (await readFile(path, "utf8")).trim() || DEFAULT_PUBLIC_PROFILE : DEFAULT_PUBLIC_PROFILE;
}

async function readRequestFiles(ws: Workspace, paths: string[]) {
  const files: { path: string; content: string }[] = [];
  let total = 0;
  for (const p of paths) {
    let abs: string;
    try {
      abs = ws.resolveRead(p);
    } catch {
      continue; // outside the workspace: never read it
    }
    if (!existsSync(abs)) continue;
    const content = (await readFile(abs, "utf8")).slice(0, MAX_FILE_CHARS);
    if (total + content.length > MAX_TOTAL_FILE_CHARS) break;
    total += content.length;
    files.push({ path: ws.display(abs), content });
  }
  return files;
}

/**
 * The broker: one model call extracts the crux and writes a re-synthesized MRE, the
 * deterministic gate checks the rendered packet, and findings are fed back for at most
 * `maxRewrites` rewrites. The broker sees only the request and files — never consultant
 * replies or web content — so a reply cannot steer it into revealing more (AirGapAgent).
 */
export function createAbstractor(opts: AbstractorOptions): Abstractor {
  const maxRewrites = opts.maxRewrites ?? 2;
  const reasoning = clampThinkingLevel(opts.model, opts.thinking ?? "medium");

  const call = async (messages: Message[], signal?: AbortSignal) => {
    for (let attempt = 1; ; attempt++) {
      const reply = await opts.models.completeSimple(
        opts.model,
        { systemPrompt: opts.systemPrompt ?? ABSTRACTION_SYSTEM_PROMPT, messages },
        { maxRetries: 3, ...(reasoning === "off" ? {} : { reasoning }), ...(signal ? { signal } : {}) },
      );
      // Retry dropped connections and overloads; anything else is reported to the caller.
      const transient = reply.stopReason === "error" && TRANSIENT.test(reply.errorMessage ?? "");
      if (!transient || attempt >= 3 || signal?.aborted) return reply;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    }
  };

  return {
    async abstract(request: ConsultRequest, signal?: AbortSignal): Promise<AbstractionResult> {
      const usage: Usage[] = [];
      const profile = await loadPublicProfile(opts.workspace);
      const files = await readRequestFiles(opts.workspace, request.files);
      const messages: Message[] = [
        {
          role: "user",
          content: renderAbstractionRequest({ profile, kind: request.kind, problem: request.problem, ...(request.attempts ? { attempts: request.attempts } : {}), files }),
          timestamp: Date.now(),
        },
      ];
      let findings: GateFinding[] = [];

      for (let attempt = 1; attempt <= maxRewrites + 1; attempt++) {
        const reply = await call(messages, signal);
        usage.push(reply.usage);
        if (reply.stopReason === "error" || reply.stopReason === "aborted") {
          return { status: "error", findings, attempts: attempt, reason: `abstraction model failed: ${reply.errorMessage ?? reply.stopReason}`, usage };
        }
        messages.push(reply);
        const text = reply.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");

        let parsed: unknown;
        try {
          parsed = extractJsonObject(text);
        } catch (err) {
          messages.push({ role: "user", content: `That was not a valid JSON object (${(err as Error).message}). Reply with the JSON object only.`, timestamp: Date.now() });
          continue;
        }
        if (!Value.Check(ResponseSchema, parsed)) {
          const errors = [...Value.Errors(ResponseSchema, parsed)].slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`);
          messages.push({ role: "user", content: `The JSON does not match the required shape: ${errors.join("; ")}. Reply with the corrected JSON object only.`, timestamp: Date.now() });
          continue;
        }
        if (parsed.status === "cannot_abstract" || !parsed.packet) {
          return { status: "blocked", findings: [], attempts: attempt, reason: parsed.reason ?? "the request cannot be abstracted", usage };
        }

        const packet: ConsultPacket = {
          kind: request.kind,
          title: parsed.packet.title,
          question: parsed.packet.question,
          ...(parsed.packet.code ? { code: parsed.packet.code } : {}),
          ...(parsed.packet.language ? { language: parsed.packet.language } : {}),
          ...(parsed.packet.constraints?.length ? { constraints: parsed.packet.constraints } : {}),
        };
        findings = opts.gate.check(renderPacket(packet));
        if (!findings.length) return { status: "ok", packet, findings: [], attempts: attempt, usage };
        messages.push({ role: "user", content: renderRewriteRequest(findings), timestamp: Date.now() });
      }
      return { status: "blocked", findings, attempts: maxRewrites + 1, reason: "project-specific text remained after rewrites", usage };
    },
  };
}
