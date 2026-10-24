import { createModels, createProvider, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { checkEndpoint } from "./guard.js";
import { AIRLOCK_IDENTITY } from "./identity.js";
import { LOCAL_PROVIDER_ID, type LocalServerConfig, type Profile } from "./profiles.js";

/** Keyless provider for a loopback OpenAI-compatible server such as llama-server. */
export function localServerProvider(config: LocalServerConfig): Provider {
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
        resolve: async () => ({ auth: { apiKey: "local" }, source: "keyless local server" }),
      },
    },
    models,
    api: openAICompletionsApi(),
  });
}

/** Registers only the providers the profile's agent roles need. */
export function buildModels(profile: Profile): MutableModels {
  const models = createModels({ identity: AIRLOCK_IDENTITY });
  const providers = new Set(Object.values(profile.roles).map((r) => r.provider));
  if (providers.has("anthropic")) models.setProvider(anthropicProvider());
  if (providers.has("deepseek")) models.setProvider(deepseekProvider());
  if (providers.has(LOCAL_PROVIDER_ID)) {
    if (!profile.localServer) throw new Error(`profile "${profile.name}" uses the local provider but has no localServer config`);
    models.setProvider(localServerProvider(profile.localServer));
  }
  return models;
}
