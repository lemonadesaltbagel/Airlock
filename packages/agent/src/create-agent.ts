import { Agent, type AgentTool, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import { checkEndpoint, egressRuleFor, guardStreamFn, type EgressRule } from "./guard.js";
import { AIRLOCK_IDENTITY } from "./identity.js";
import { buildModels } from "./models.js";
import type { Profile } from "./profiles.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { createCodingTools } from "./tools/index.js";
import { createWorkspace, type Workspace } from "./workspace.js";

/** Provider-level retries for connection errors, 429s and 5xx (never for refusals or 4xx). */
export const REQUEST_RETRIES = 3;

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
  onBlockedRequest?: (model: Model<Api>, reason: string) => void;
}

export interface AirlockAgent {
  agent: Agent;
  model: Model<Api>;
  workspace: Workspace;
}

export function createAirlockAgent(opts: CreateAirlockAgentOptions): AirlockAgent {
  const ref = opts.profile.roles[opts.role ?? "loop"];
  const models = opts.models ?? buildModels(opts.profile);
  const model = models.getModel(ref.provider, ref.model);
  if (!model) throw new Error(`model ${ref.provider}/${ref.model} is not registered`);

  const rule = opts.egressRule ?? egressRuleFor(opts.profile, models);
  // Fail at construction rather than on the first request.
  const check = checkEndpoint(model.baseUrl, rule);
  if (!check.ok) throw new Error(`refusing to create agent: ${check.reason}`);

  const workspace = createWorkspace(opts.workspaceRoot);
  // pi-ai retries failed provider requests only when asked; the Agent does not forward the option.
  const retrying: StreamFn = (model, context, options) => models.streamSimple(model, context, { maxRetries: REQUEST_RETRIES, ...options });
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
  return { agent, model, workspace };
}
