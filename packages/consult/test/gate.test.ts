import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkspace } from "@airlock/agent";
import { describe, expect, it } from "vitest";
import { canonicalIdentifier, identifierParts } from "../src/common-words.js";
import { FragmentIndex } from "../src/fragment-index.js";
import { createGate } from "../src/gate.js";
import { emptyJewels, loadJewels } from "../src/jewels.js";
import { buildRepoIndex, isDistinctiveIdentifier } from "../src/repo-index.js";
import { findSecrets } from "../src/secrets.js";
import { makeProject, NEUTRAL_MRE, PRIVATE_PROJECT } from "./fixtures.js";

describe("identifiers", () => {
  it("splits and canonicalizes across naming styles", () => {
    expect(identifierParts("computeSurgeMultiplier")).toEqual(["compute", "surge", "multiplier"]);
    expect(identifierParts("HTTPServerError")).toEqual(["http", "server", "error"]);
    expect(canonicalIdentifier("SurgeMultiplier")).toBe(canonicalIdentifier("surge_multiplier"));
  });

  it("treats generic vocabulary as non-distinctive", () => {
    for (const id of ["user_id", "maxRetries", "parseConfigFile", "self", "__init__", "multiplier"]) {
      expect(isDistinctiveIdentifier(id), id).toBe(false);
    }
    for (const id of ["compute_surge_multiplier", "FleetwiseSurgeEngine", "LANE_SURGE_CAP", "Fleetwise"]) {
      expect(isDistinctiveIdentifier(id), id).toBe(true);
    }
  });
});

describe("FragmentIndex", () => {
  it("detects any shared fragment of the guaranteed length, ignoring case and whitespace", () => {
    const idx = new FragmentIndex(24, 8);
    const source = "the quick brown fox jumps over the lazy dog while the cat sleeps soundly";
    idx.add(source, "a.txt");
    expect(idx.guaranteedLength).toBe(31);
    for (let start = 0; start + 31 <= source.length; start += 3) {
      const frag = source.slice(start, start + 31).toUpperCase().replace(/ /g, "   ");
      expect(idx.find(`prefix ${frag} suffix`).length, frag).toBeGreaterThan(0);
    }
    expect(idx.find("completely unrelated sentence about something else entirely")).toEqual([]);
  });
});

describe("secrets", () => {
  it("finds credentials and identifying infrastructure", () => {
    const text = "key sk-ant-api03-abcdefghijklmnopqrstuv mail bob@acme-freight.com path /Users/bob/x ip 10.2.3.4";
    expect(findSecrets(text).map((f) => f.detail)).toEqual(
      expect.arrayContaining(["Anthropic API key", "email address", "home directory path", "private IPv4 address"]),
    );
    expect(findSecrets("contact someone@example.com")).toEqual([]);
  });
});

describe("gate", () => {
  async function gateFor(root: string) {
    const ws = createWorkspace(root);
    const repo = await buildRepoIndex(ws);
    return { gate: createGate(repo, await loadJewels(ws, repo.files)), repo };
  }

  it("indexes project names, identifiers and literals but not generic names", async () => {
    const { repo } = await gateFor(makeProject());
    expect(repo.projectNames).toEqual(expect.arrayContaining(["fleetwise-pricing"]));
    expect(repo.identifiers.has(canonicalIdentifier("compute_surge_multiplier"))).toBe(true);
    expect(repo.identifiers.has(canonicalIdentifier("user_id"))).toBe(false);
    expect([...repo.literals]).toContain("acme priority lane overbooked");
  });

  it("does not block standard-library names or prose words", async () => {
    const root = makeProject({
      ...PRIVATE_PROJECT,
      "fleetwise/money.py": "from decimal import Decimal, ROUND_HALF_UP\nfrom typing import Optional\n# Instead of floats we use Decimal.\n",
      "tests/test_money.py": "import unittest\nclass MoneyTest(unittest.TestCase):\n    def test_x(self):\n        self.assertAlmostEqual(1, 1)\n",
    });
    const { gate } = await gateFor(root);
    expect(gate.check("Use Decimal(...).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP); Optional[int]; self.assertAlmostEqual(a, b). Instead, try this.")).toEqual([]);
  });

  it("passes a neutral, rewritten example", async () => {
    const { gate } = await gateFor(makeProject());
    expect(gate.check(NEUTRAL_MRE)).toEqual([]);
  });

  it("catches project identifiers in any casing, literals, project names and copied code", async () => {
    const { gate } = await gateFor(makeProject());
    const rules = (text: string) => gate.check(text).map((f) => f.rule);
    expect(rules("Why does ComputeSurgeMultiplier return a tuple?")).toContain("identifier");
    expect(rules("the label says 'Acme priority lane overbooked'")).toContain("literal");
    expect(rules("question about fleetwise-pricing")).toContain("jewel-term");
    expect(rules("    def compute(self, booked, cap):\n        utilisation = booked_tons / lane_capacity_tons\n        label = 'x'")).toEqual(
      expect.arrayContaining(["identifier"]),
    );
    const copied = 'utilisation = booked_tons / lane_capacity_tons\n        label = "Acme priority lane overbooked"\n        return min(';
    expect(rules(copied)).toContain("repo-fragment");
  });

  it("enforces declared crown jewels", async () => {
    const root = makeProject();
    mkdirSync(join(root, ".airlock"));
    writeFileSync(join(root, ".airlock/jewels.json"), JSON.stringify({ terms: ["Project Bluebird"], files: ["fleetwise/surge.py"] }));
    const { gate } = await gateFor(root);
    expect(gate.check("is this like project bluebird?").map((f) => f.rule)).toContain("jewel-term");
    expect(gate.check("utilisation = booked_tons / lane_capacity").map((f) => f.rule)).toContain("jewel-fragment");
  });

  it("works with no jewels file", () => {
    expect(emptyJewels().terms).toEqual([]);
  });
});
