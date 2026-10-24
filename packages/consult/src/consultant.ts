import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Api, type Model, type Models, type Usage } from "@earendil-works/pi-ai";

/**
 * Kept generic on purpose: the consultant should answer the question as asked. Telling it the
 * question was abstracted would invite it to guess (or ask for) what was removed.
 */
export const CONSULTANT_SYSTEM_PROMPT = `You are a senior software engineer answering a self-contained technical question from another developer.

The question is complete as given. Answer it directly: explain the cause or the trade-off, and give corrected or example code where it helps. Prefer general, reusable explanations over guesses about the asker's wider system. If something essential is missing, state the assumption you made and answer anyway.`;

export type ConsultantStatus = "answered" | "refused" | "error";

export interface ConsultantAnswer {
  status: ConsultantStatus;
  text: string;
  model: string;
  usage?: Usage;
  errorMessage?: string;
}

export interface Consultant {
  readonly model: Model<Api>;
  ask(outbound: string, signal?: AbortSignal): Promise<ConsultantAnswer>;
}

export interface ConsultantOptions {
  models: Models;
  model: Model<Api>;
  thinking?: ThinkingLevel;
  /** Opaque per-user id sent as provider metadata, so enforcement lands on this user, not the key. */
  userId?: string;
  /** Attempts for transient infrastructure errors. Default 3. Refusals are never retried. */
  maxAttempts?: number;
}

const TRANSIENT = /connection|terminated|timed? ?out|ECONNRESET|ETIMEDOUT|socket|fetch failed|overloaded|rate.?limit|\b429\b|\b5\d\d\b/i;

export function createConsultant(opts: ConsultantOptions): Consultant {
  const reasoning = clampThinkingLevel(opts.model, opts.thinking ?? "high");
  return {
    model: opts.model,
    async ask(outbound, signal) {
      for (let attempt = 1; ; attempt++) {
        const answer = await askOnce(outbound, signal);
        // Refusals are final; only infrastructure errors are retried.
        if (answer.status !== "error" || attempt >= (opts.maxAttempts ?? 3) || !TRANSIENT.test(answer.errorMessage ?? "") || signal?.aborted) return answer;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
      }
    },
  };

  async function askOnce(outbound: string, signal?: AbortSignal): Promise<ConsultantAnswer> {
    const message = await opts.models.completeSimple(
      opts.model,
      {
        systemPrompt: CONSULTANT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: outbound, timestamp: Date.now() }],
      },
      {
        maxRetries: 3,
        ...(reasoning === "off" ? {} : { reasoning }),
        ...(opts.userId ? { metadata: { user_id: opts.userId } } : {}),
        ...(signal ? { signal } : {}),
      },
    );
    const text = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    const id = `${opts.model.provider}/${opts.model.id}`;
    if (message.rawStopReason === "refusal") {
      return { status: "refused", text, model: id, usage: message.usage, errorMessage: message.errorMessage ?? "refused" };
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return { status: "error", text, model: id, usage: message.usage, errorMessage: message.errorMessage ?? message.stopReason };
    }
    return { status: "answered", text, model: id, usage: message.usage };
  }
}
