/**
 * Environment for processes the agent spawns (bash tool). Built from an allowlist so
 * API keys and other secrets in Airlock's own environment never reach child processes,
 * plus best-effort telemetry opt-outs. These opt-outs only reduce noise: the guarantee
 * comes from a deny-by-default network sandbox (planned), not from env vars.
 */
const PASSTHROUGH_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
] as const;

export const TELEMETRY_OPT_OUT_ENV: Readonly<Record<string, string>> = {
  DO_NOT_TRACK: "1",
  HF_HUB_DISABLE_TELEMETRY: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  NUXT_TELEMETRY_DISABLED: "1",
  GATSBY_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  STORYBOOK_DISABLE_TELEMETRY: "1",
  NG_CLI_ANALYTICS: "false",
  EXPO_NO_TELEMETRY: "1",
  YARN_ENABLE_TELEMETRY: "0",
  NO_UPDATE_NOTIFIER: "1",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  HOMEBREW_NO_ANALYTICS: "1",
  HOMEBREW_NO_AUTO_UPDATE: "1",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  POWERSHELL_TELEMETRY_OPTOUT: "1",
  AZURE_CORE_COLLECT_TELEMETRY: "0",
  SAM_CLI_TELEMETRY: "0",
  CHECKPOINT_DISABLE: "1",
  GOTELEMETRY: "off",
  GRADIO_ANALYTICS_ENABLED: "False",
  STREAMLIT_BROWSER_GATHER_USAGE_STATS: "false",
  ANONYMIZED_TELEMETRY: "False",
  SCARF_NO_ANALYTICS: "true",
  HAYSTACK_TELEMETRY_ENABLED: "False",
  DBT_SEND_ANONYMOUS_USAGE_STATS: "False",
  SEMGREP_SEND_METRICS: "off",
  VLLM_NO_USAGE_STATS: "1",
  RAY_USAGE_STATS_ENABLED: "0",
  WANDB_MODE: "disabled",
  LANGCHAIN_TRACING_V2: "false",
  LANGSMITH_TRACING: "false",
  LITELLM_TELEMETRY: "False",
  CREWAI_DISABLE_TELEMETRY: "true",
  MEM0_TELEMETRY: "False",
  OTEL_SDK_DISABLED: "true",
  OLLAMA_NO_CLOUD: "1",
  PI_TELEMETRY: "0",
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
};

export function buildChildEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...TELEMETRY_OPT_OUT_ENV };
}
