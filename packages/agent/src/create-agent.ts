import { Agent, type AgentTool, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import { checkEndpoint, egressRuleFor, guardStreamFn, type EgressRule } from "./guard.js";
import { AIRLOCK_IDENTITY } from "./identity.js";
import { buildModels, gatewayBaseUrl } from "./models.js";
import type { Profile } from "./profiles.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { createCodingTools } from "./tools/index.js";
import { createWorkspace, type Workspace } from "./workspace.js";

/** Provider-level retries for connection errors, 429s and 5xx (never for refusals or 4xx). */
export const REQUEST_RETRIES = 3;

/**
 * Output tokens requested per agent turn. Provider catalogs can list a maximum close to the whole
 * context window (Qwen3.6 on OpenRouter: ~236k of 262k), and requesting it fails once the
 * conversation is long.
 */
export const AGENT_MAX_OUTPUT_TOKENS = 32_768;

export interface CreateAirlockAgentOptions {
  workspaceRoot: string;
  profile: Profile;
  /** Which agent role's model drives this agent. Default: "loop". */
  role?: keyof Profile["roles"];
  /** Injected for tests; defaults to the providers the profile needs. */
  models?: Models;
  /** Injected for tests; overrides the profile-derived rule. */
  egressRule?: EgressRule;
  tools?: (ws: Workspace) => AgentTool<any>[];
  /**
   * Gateway URL: the model is addressed through the gateway's relay instead of its provider
   * (the sandboxed agent can reach nothing else).
   */
  gatewayUrl?: string;
  onBlockedRequest?: (model: Model<Api>, reason: string) => void;
}

export interface AirlockAgent {
  agent: Agent;
  model: Model<Api>;
  workspace: Workspace;
  /**
   * Makes the next model request call this tool (provider tool choice), instead of leaving the
   * choice to the model. Used when Airlock must have a consult: small models often ignore being asked.
   */
  forceToolOnNextRequest(toolName: string): void;
}

/** Adds a forced tool choice to a request payload, in the shape each API expects. */
export function withForcedTool(payload: unknown, api: string, toolName: string): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const p = payload as Record<string, unknown>;
  if (api === "openai-completions") return { ...p, tool_choice: { type: "function", function: { name: toolName } } };
  // Anthropic refuses a forced tool while extended thinking is on; the instruction alone has to do.
  if (api === "anthropic-messages" && !(p.thinking as { type?: string } | undefined)?.type?.startsWith("enabled")) return { ...p, tool_choice: { type: "tool", name: toolName } };
  return payload;
}

export function createAirlockAgent(opts: CreateAirlockAgentOptions): AirlockAgent {
  const ref = opts.profile.roles[opts.role ?? "loop"];
  const models = opts.models ?? buildModels(opts.profile);
  const registered = models.getModel(ref.provider, ref.model);
  if (!registered) throw new Error(`model ${ref.provider}/${ref.model} is not registered`);
  const model: Model<Api> = opts.gatewayUrl ? { ...registered, baseUrl: gatewayBaseUrl(opts.gatewayUrl, registered.provider) } : registered;

  const rule = opts.egressRule ?? egressRuleFor(opts.profile, models);
  // Fail at construction rather than on the first request.
  const check = checkEndpoint(model.baseUrl, rule);
  if (!check.ok) throw new Error(`refusing to create agent: ${check.reason}`);

  const workspace = createWorkspace(opts.workspaceRoot);
  // pi-ai retries failed provider requests only when asked; the Agent does not forward the option.
  let forcedTool: string | undefined;
  const retrying: StreamFn = (model, context, options) => {
    const tool = forcedTool;
    forcedTool = undefined;
    const base = { maxRetries: REQUEST_RETRIES, maxTokens: Math.min(model.maxTokens, AGENT_MAX_OUTPUT_TOKENS) };
    if (!tool) return models.streamSimple(model, context, { ...base, ...options });
    const inner = options?.onPayload;
    return models.streamSimple(model, context, {
      ...base,
      ...options,
      onPayload: async (payload, m) => withForcedTool((await inner?.(payload, m)) ?? payload, m.api, tool),
    });
  };
  const streamFn: StreamFn = guardStreamFn(retrying, rule, opts.onBlockedRequest);
  const agent = new Agent({
    initialState: {
      systemPrompt: SYSTEM_PROMPT,
      model,
      thinkingLevel: clampThinkingLevel(model, ref.thinking ?? "medium") as ThinkingLevel,
      tools: (opts.tools ?? createCodingTools)(workspace),
    },
    streamFn,
    identity: AIRLOCK_IDENTITY,
  });
  return {
    agent,
    model,
    workspace,
    forceToolOnNextRequest: (toolName) => {
      forcedTool = toolName;
    },
  };
}
