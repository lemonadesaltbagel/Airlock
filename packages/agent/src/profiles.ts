import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * `local`: every agent role runs on the user's machine. The only profile real projects may use.
 * `dev-cloud` / `dev-cloud-deepseek`: the "local" roles are served by cloud models (Anthropic, or
 * cheaper DeepSeek models) so the pipeline can be iterated quickly. They send full project context
 * to the cloud, so they are restricted to synthetic or public projects (see devcloud.ts).
 */
export type ProfileName = "local" | "dev-cloud" | "dev-cloud-deepseek";

export function isDevCloud(name: ProfileName): boolean {
  return name !== "local";
}

export interface ModelRef {
  provider: string;
  model: string;
  thinking?: ThinkingLevel;
}

export interface LocalModelSpec {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning?: boolean;
}

export interface LocalServerConfig {
  /** OpenAI-compatible endpoint, e.g. llama-server. Must be loopback. */
  baseUrl: string;
  models: LocalModelSpec[];
}

export interface Profile {
  name: ProfileName;
  /** Models the agent itself talks to. All of them must pass the provider guard. */
  roles: {
    /** Fast model driving the tool loop. */
    loop: ModelRef;
    /** Strongest available model for one-shot abstraction / re-grounding calls. */
    quality: ModelRef;
  };
  /**
   * The frontier consultant. Never called by the agent directly: once the gateway exists, only it
   * holds its key and calls it on the agent's behalf. Recorded here so the profile is complete.
   */
  consultant: ModelRef;
  localServer?: LocalServerConfig;
}

export const LOCAL_PROVIDER_ID = "local";
/** llama-server's default port since v0.7.0. */
export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:9931/v1";

const CONSULTANT: ModelRef = { provider: "anthropic", model: "claude-opus-5-5", thinking: "high" };

export const PROFILES: Record<ProfileName, Profile> = {
  local: {
    name: "local",
    roles: {
      loop: { provider: LOCAL_PROVIDER_ID, model: "qwen3.6-35b-a3b" },
      quality: { provider: LOCAL_PROVIDER_ID, model: "qwen3.6-35b-a3b" },
    },
    consultant: CONSULTANT,
    localServer: {
      baseUrl: DEFAULT_LOCAL_BASE_URL,
      models: [{ id: "qwen3.6-35b-a3b", name: "Qwen3.6-35B-A3B (llama-server)", contextWindow: 65_536, maxTokens: 16_384, reasoning: true }],
    },
  },
  "dev-cloud": {
    name: "dev-cloud",
    roles: {
      loop: { provider: "anthropic", model: "claude-haiku-4-5", thinking: "medium" },
      quality: { provider: "anthropic", model: "claude-haiku-4-5", thinking: "medium" },
    },
    consultant: CONSULTANT,
  },
  "dev-cloud-deepseek": {
    name: "dev-cloud-deepseek",
    roles: {
      loop: { provider: "deepseek", model: "deepseek-flash", thinking: "high" },
      quality: { provider: "deepseek", model: "deepseek-flash", thinking: "high" },
    },
    consultant: { provider: "deepseek", model: "deepseek-v4-pro", thinking: "high" },
  },
};

export function getProfile(name: string): Profile {
  if (Object.hasOwn(PROFILES, name)) return PROFILES[name as ProfileName];
  throw new Error(`unknown profile "${name}" (expected ${Object.keys(PROFILES).map((n) => `"${n}"`).join(", ")})`);
}
