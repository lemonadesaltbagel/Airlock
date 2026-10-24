import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A small "private" project: a freight-pricing tool with a distinctive surge rule. */
export const PRIVATE_PROJECT: Record<string, string> = {
  "pyproject.toml": `[project]\nname = "fleetwise-pricing"\nversion = "0.1.0"\n`,
  "README.md": "# Fleetwise\nDynamic pricing for Acme Freight's priority lanes.\n",
  "fleetwise/surge.py": `"""Surge pricing for Acme Freight priority lanes."""

LANE_SURGE_CAP = 3.75


class FleetwiseSurgeEngine:
    def __init__(self, user_id, max_retries=3):
        self.user_id = user_id
        self.max_retries = max_retries

    def compute_surge_multiplier(self, booked_tons, lane_capacity_tons):
        utilisation = booked_tons / lane_capacity_tons
        label = "Acme priority lane overbooked"
        return min(LANE_SURGE_CAP, 1 + utilisation ** 2), label
`,
};

export function makeProject(files: Record<string, string> = PRIVATE_PROJECT): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-consult-")));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

export const NEUTRAL_MRE = `# Capped quadratic multiplier returns wrong type

My function should return a single float, but callers get a tuple.

\`\`\`python
def multiplier(used, capacity, cap=2.0):
    ratio = used / capacity
    return min(cap, 1 + ratio ** 2), "note"
\`\`\``;
