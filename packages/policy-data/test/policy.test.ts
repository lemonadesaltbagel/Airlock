import { describe, expect, it } from "vitest";
import { describePolicy, findPolicy, isPolicyStale, POLICIES, policyAgeDays } from "../src/index.js";

describe("findPolicy", () => {
  it("uses the provider-wide entry for ordinary models", () => {
    expect(findPolicy("anthropic", "claude-opus-5-5")?.id).toBe("anthropic/default");
    expect(findPolicy("anthropic", "claude-haiku-4-5")?.id).toBe("anthropic/default");
  });

  it("prefers model-specific entries (Covered Models require retention)", () => {
    for (const id of ["claude-fable-5", "claude-fable-5-1", "claude-mythos-5-1"]) {
      const p = findPolicy("anthropic", id);
      expect(p?.id, id).toBe("anthropic/covered-models");
      expect(p?.zeroDataRetention.available).toBe(false);
    }
    expect(findPolicy("amazon-bedrock", "anthropic.claude-fable-5-1")?.id).toBe("amazon-bedrock/claude-fable");
    expect(findPolicy("amazon-bedrock", "anthropic.claude-opus-5-5")?.id).toBe("amazon-bedrock/claude");
  });

  it("returns undefined for unknown providers and models rather than guessing", () => {
    expect(findPolicy("mistral", "mistral-large")).toBeUndefined();
    expect(findPolicy("amazon-bedrock", "meta.llama-4")).toBeUndefined();
  });
});

describe("deepseek", () => {
  it("warns about training and PRC storage", () => {
    const p = findPolicy("deepseek", "deepseek-flash")!;
    expect(p.trainsOnApiData).toBe("opt-out-required");
    expect(p.warnings.join(" ")).toMatch(/PRC/);
  });
});

describe("registry integrity", () => {
  it("has unique ids, valid patterns and dates, and sources for every remote provider", () => {
    expect(new Set(POLICIES.map((p) => p.id)).size).toBe(POLICIES.length);
    for (const p of POLICIES) {
      if (p.modelPattern) expect(() => new RegExp(p.modelPattern!)).not.toThrow();
      expect(p.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (p.provider !== "local") expect(p.sources.length, p.id).toBeGreaterThan(0);
    }
  });
});

describe("staleness", () => {
  const policy = findPolicy("anthropic", "claude-opus-5-5")!;

  it("flags entries older than 90 days", () => {
    expect(policyAgeDays(policy, new Date("2026-10-22T12:00:00Z"))).toBe(1);
    expect(isPolicyStale(policy, new Date("2026-12-01T00:00:00Z"))).toBe(false);
    expect(isPolicyStale(policy, new Date("2027-02-01T00:00:00Z"))).toBe(true);
  });

  it("tells the user to re-check stale policies", () => {
    expect(describePolicy(policy, new Date("2027-02-01T00:00:00Z")).join("\n")).toMatch(/re-check/);
  });
});
