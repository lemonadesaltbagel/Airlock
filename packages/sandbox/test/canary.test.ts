import { describe, expect, it } from "vitest";
import { runCanary, sandboxAvailability } from "../src/index.js";

describe.skipIf(!sandboxAvailability().ok)("egress canary (OS sandbox)", () => {
  it("blocks every exfiltration path and allows the controls", async () => {
    const report = await runCanary();
    const failed = report.outcomes.filter((o) => !o.passed).map((o) => `${o.probe.id} (expected ${o.probe.expect}): ${o.result.output.slice(0, 200)}`);
    expect(failed).toEqual([]);
    expect(report.outcomes.filter((o) => o.probe.expect === "blocked").length).toBeGreaterThanOrEqual(15);
    expect(report.leftovers).toEqual([]);
    // Unlisted hosts reach the egress decider (which denied them), so they can be logged.
    expect(report.asked).toContain("example.com:443");
    expect(report.asked.some((h) => h.startsWith("telemetry.nextjs.org"))).toBe(true);
  }, 120_000);
});
