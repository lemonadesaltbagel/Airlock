import { POLICIES } from "./registry.js";
import type { DataPolicy } from "./types.js";

export { POLICIES } from "./registry.js";
export type { DataPolicy, TrainingDefault } from "./types.js";

export const DEFAULT_MAX_POLICY_AGE_DAYS = 90;

/**
 * The policy for a model: the first entry (in registry order) whose modelPattern matches,
 * else the provider-wide entry.
 * Returns undefined for providers Airlock has no verified data on — callers must treat that
 * as "unknown", never as "safe".
 */
export function findPolicy(provider: string, modelId: string, policies: readonly DataPolicy[] = POLICIES): DataPolicy | undefined {
  const forProvider = policies.filter((p) => p.provider === provider);
  return (
    forProvider.find((p) => p.modelPattern !== undefined && new RegExp(p.modelPattern).test(modelId)) ??
    forProvider.find((p) => p.modelPattern === undefined)
  );
}

export function policyAgeDays(policy: DataPolicy, now: Date = new Date()): number {
  const verified = Date.parse(`${policy.verifiedOn}T00:00:00Z`);
  if (Number.isNaN(verified)) throw new Error(`invalid verifiedOn date in policy ${policy.id}: ${policy.verifiedOn}`);
  return Math.floor((now.getTime() - verified) / 86_400_000);
}

export function isPolicyStale(policy: DataPolicy, now: Date = new Date(), maxAgeDays = DEFAULT_MAX_POLICY_AGE_DAYS): boolean {
  return policyAgeDays(policy, now) > maxAgeDays;
}

/** Plain-language lines for showing a policy to the user. */
export function describePolicy(policy: DataPolicy, now: Date = new Date()): string[] {
  const training = {
    no: "Not used for training by default.",
    yes: "USED FOR TRAINING by default.",
    "opt-out-required": "Used for training unless you opt out.",
    unclear: "Training use is unclear.",
  }[policy.trainsOnApiData];
  const lines = [
    policy.label,
    `  Training:   ${training}`,
    `  Retention:  ${policy.retentionSummary}`,
    `  Flagged:    ${policy.flaggedContent}`,
    `  Review:     ${policy.humanReview}`,
    `  Zero retention: ${policy.zeroDataRetention.summary}`,
    `  Residency:  ${policy.residency}`,
  ];
  for (const w of policy.warnings) lines.push(`  ! ${w}`);
  const age = policyAgeDays(policy, now);
  lines.push(
    isPolicyStale(policy, now)
      ? `  ! Last verified ${policy.verifiedOn} (${age} days ago) — re-check the provider's current terms.`
      : `  Verified ${policy.verifiedOn}.`,
  );
  return lines;
}
