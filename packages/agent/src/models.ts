import { createModels, createProvider, type Api, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { checkEndpoint } from "./guard.js";
import { AIRLOCK_IDENTITY } from "./identity.js";
import { LOCAL_PROVIDER_ID, type LocalServerConfig, type Profile } from "./profiles.js";

/** Environment variable each cloud provider reads its key from. */
export const PROVIDER_KEY_ENV: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", deepseek: "DEEPSEEK_API_KEY", openrouter: "OPENROUTER_API_KEY" };

/**
 * OpenRouter routes each request to one of several hosting providers. Airlock pins the routing:
 * only endpoints with zero data retention that do not collect data, at fp8 or better (so results
 * are comparable across runs), and only endpoints that support every parameter sent (tools).
 */
export const OPENROUTER_ROUTING = {
  zdr: true,
  data_collection: "deny",
  quantizations: ["fp8", "bf16", "fp16"],
  require_parameters: true,
} as const;

function openrouterRoutedProvider(): Provider {
  const inner = openrouterProvider();
  const route = <T extends Model<Api>>(m: T): T => (m.api === "openai-completions" ? { ...m, compat: { ...(m as Model<"openai-completions">).compat, openRouterRouting: { ...OPENROUTER_ROUTING, quantizations: [...OPENROUTER_ROUTING.quantizations] } } } : m);
  return {
    ...inner,
    getModels: (...args: Parameters<Provider["getModels"]>) => inner.getModels(...args).map((m) => route(m as Model<Api>)),
    ...(inner.getAllModels ? { getAllModels: () => inner.getAllModels!().map((m) => route(m as Model<Api>)) } : {}),
  } as Provider;
}

/** The relay path for a provider on the gateway: the agent's models are addressed through it. */
export function gatewayBaseUrl(gatewayUrl: string, provider: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/llm/${provider}`;
}

/**
 * Provider for a loopback OpenAI-compatible server such as llama-server. Keyless, except that the
 * sandboxed agent presents its gateway token, which the gateway strips before relaying.
 */
export function localServerProvider(config: LocalServerConfig, apiKey = "local"): Provider {
  const check = checkEndpoint(config.baseUrl, { allowedOrigins: [] });
  if (!check.ok) throw new Error(`local server must be on loopback: ${check.reason}`);
  const models: Model<"openai-completions">[] = config.models.map((spec) => ({
    id: spec.id,
    name: spec.name ?? spec.id,
    api: "openai-completions",
    provider: LOCAL_PROVIDER_ID,
    baseUrl: config.baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: spec.reasoning ?? false,
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  }));
  return createProvider({
    id: LOCAL_PROVIDER_ID,
    name: "Local model server",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "Local server (no key)",
        resolve: async () => ({ auth: { apiKey }, source: "keyless local server" }),
      },
    },
    models,
    api: openAICompletionsApi(),
  });
}

/** Registers only the providers the profile's agent roles need. */
export function buildModels(profile: Profile, opts: { localApiKey?: string } = {}): MutableModels {
  const models = createModels({ identity: AIRLOCK_IDENTITY });
  const providers = new Set(Object.values(profile.roles).map((r) => r.provider));
  if (providers.has("anthropic")) models.setProvider(anthropicProvider());
  if (providers.has("deepseek")) models.setProvider(deepseekProvider());
  if (providers.has("openrouter")) models.setProvider(openrouterRoutedProvider());
  if (providers.has(LOCAL_PROVIDER_ID)) {
    if (!profile.localServer) throw new Error(`profile "${profile.name}" uses the local provider but has no localServer config`);
    models.setProvider(localServerProvider(profile.localServer, opts.localApiKey));
  }
  return models;
}
