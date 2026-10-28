import type { StreamFn } from "@earendil-works/pi-agent-core";
import { lazyStream, type Api, type Model } from "@earendil-works/pi-ai";
import { isDevCloud, type Profile } from "./profiles.js";

/**
 * Fail-closed check on where the agent's LLM requests go. This is defence in depth against
 * misconfiguration (a profile or model pointing somewhere unexpected), NOT a security
 * boundary: code running in-process could bypass it. The boundary is the OS sandbox plus
 * gateway (planned).
 */
export interface EgressRule {
  /** Exact origins (scheme://host[:port]) allowed besides loopback. */
  allowedOrigins: readonly string[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
}

export type EndpointCheck = { ok: true } | { ok: false; reason: string };

export function checkEndpoint(baseUrl: string, rule: EgressRule): EndpointCheck {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, reason: `invalid model baseUrl: ${baseUrl}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol ${url.protocol} in ${baseUrl}` };
  }
  if (isLoopbackUrl(url)) return { ok: true };
  if (url.protocol !== "https:") return { ok: false, reason: `non-loopback endpoint must use https: ${baseUrl}` };
  if (rule.allowedOrigins.includes(url.origin)) return { ok: true };
  return { ok: false, reason: `endpoint ${url.origin} is not allowed by the active profile` };
}

/** Origins the agent may reach under a profile: loopback always, cloud only for dev-cloud roles. */
export function egressRuleFor(profile: Profile, models: { getModel(provider: string, id: string): Model<Api> | undefined }): EgressRule {
  if (!isDevCloud(profile.name)) return { allowedOrigins: [] };
  const origins = new Set<string>();
  for (const ref of Object.values(profile.roles)) {
    const model = models.getModel(ref.provider, ref.model);
    if (model) origins.add(new URL(model.baseUrl).origin);
  }
  return { allowedOrigins: [...origins] };
}

export class ProviderGuardError extends Error {
  override name = "ProviderGuardError";
}

export function guardStreamFn(inner: StreamFn, rule: EgressRule, onBlocked?: (model: Model<Api>, reason: string) => void): StreamFn {
  return (model, context, options) => {
    const check = checkEndpoint(model.baseUrl, rule);
    if (check.ok) return inner(model, context, options);
    onBlocked?.(model, check.reason);
    // StreamFn must not throw: encode the refusal as a failed stream.
    return lazyStream(model, async () => {
      throw new ProviderGuardError(`blocked LLM request to ${model.provider}/${model.id}: ${check.reason}`);
    });
  };
}
