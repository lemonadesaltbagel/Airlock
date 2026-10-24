import { canonicalIdentifier } from "./common-words.js";
import type { Jewels } from "./jewels.js";
import type { RepoIndex } from "./repo-index.js";
import { findSecrets } from "./secrets.js";
import type { GateFinding } from "./types.js";

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
const MAX_FINDINGS = 40;

/**
 * Deterministic last check on outbound text. No model is involved, so it cannot be talked out
 * of a decision. It catches raw leakage (secrets, copied code, project identifiers, jewel
 * strings); it cannot catch paraphrased intent — that is the shadow attacker's job (M3).
 */
export interface Gate {
  check(text: string): GateFinding[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createGate(repo: RepoIndex, jewels: Jewels): Gate {
  const terms = [...new Set([...jewels.terms, ...repo.projectNames])];
  const termRes = terms.map((t) => ({ term: t, re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(t)}(?![A-Za-z0-9])`, "i") }));

  return {
    check(text) {
      const findings: GateFinding[] = [...findSecrets(text)];

      for (const { term, re } of termRes) {
        const m = text.match(re);
        if (m) findings.push({ rule: "jewel-term", match: m[0], detail: `declared secret or project name "${term}"` });
      }
      for (const f of jewels.fragments.find(text)) {
        findings.push({ rule: "jewel-fragment", match: f.fragment, detail: `copied from crown-jewel file ${f.source}` });
      }
      for (const f of repo.fragments.find(text)) {
        findings.push({ rule: "repo-fragment", match: f.fragment, detail: `copied verbatim from ${f.source}` });
      }

      const seen = new Set<string>();
      for (const m of text.matchAll(IDENTIFIER_RE)) {
        const canon = canonicalIdentifier(m[0]);
        if (seen.has(canon)) continue;
        seen.add(canon);
        const original = repo.identifiers.get(canon);
        if (original) findings.push({ rule: "identifier", match: m[0], detail: `project identifier ${original}` });
      }

      const lower = text.toLowerCase();
      for (const lit of repo.literals) {
        if (lower.includes(lit)) findings.push({ rule: "literal", match: lit, detail: "string literal from the project" });
      }

      // Dedupe by rule+match and cap so a rewrite prompt stays readable.
      const unique = new Map(findings.map((f) => [`${f.rule}\u0000${f.match.toLowerCase()}`, f]));
      return [...unique.values()].slice(0, MAX_FINDINGS);
    },
  };
}
