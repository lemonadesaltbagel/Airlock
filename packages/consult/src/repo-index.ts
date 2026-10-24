import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Workspace } from "@airlock/agent";
import { canonicalIdentifier, identifierParts, isCommonPart } from "./common-words.js";
import { FragmentIndex } from "./fragment-index.js";
import { PUBLIC_API_NAMES } from "./public-api.js";

const SKIP_DIRS = new Set([".git", ".airlock", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", "target", ".next"]);
const TEXT_EXTENSIONS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".c", ".h",
  ".cc", ".cpp", ".hpp", ".cs", ".swift", ".scala", ".sql", ".sh", ".md", ".txt", ".rst", ".json", ".yaml",
  ".yml", ".toml", ".ini", ".cfg", ".html", ".css", ".vue", ".svelte",
]);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** Repo-wide verbatim detection: fragments of ≥ 63 normalized characters. */
export const REPO_FRAGMENT_WINDOW = 48;
export const REPO_FRAGMENT_STRIDE = 16;

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]{3,}/g;
const LITERAL_RE = /(["'`])((?:(?!\1)[^\\\n]|\\.){8,160})\1/g;

export interface RepoIndex {
  /** Canonical forms of project-specific identifiers (see common-words.ts). */
  identifiers: Map<string, string>;
  /** Project-specific string literals, lower-cased. */
  literals: Set<string>;
  fragments: FragmentIndex;
  /** Names the project goes by: directory name, package names. */
  projectNames: string[];
  files: string[];
}

/**
 * An identifier is project-specific if it isn't a standard-library or framework name and any of
 * its parts is not generic programming vocabulary.
 */
export function isDistinctiveIdentifier(identifier: string): boolean {
  if (PUBLIC_API_NAMES.has(identifier)) return false;
  const parts = identifierParts(identifier);
  if (!parts.some((p) => !isCommonPart(p))) return false;
  // Single-part names are only distinctive when they look like a proper name (class, product).
  return parts.length >= 2 || (/^[A-Z]/.test(identifier) && identifier.length >= 6);
}

const PROSE_EXTENSIONS = new Set([".md", ".txt", ".rst"]);

/**
 * Comments and docstrings are prose: capitalised sentence-initial words ("Instead", "Energy")
 * are not identifiers. They are removed before identifier extraction; names that only appear in
 * prose are covered by string literals and declared jewel terms.
 */
export function stripComments(content: string, ext: string): string {
  if (ext === ".py") return content.replace(/("""|\'\'\')[\s\S]*?\1/g, " ").replace(/#.*$/gm, " ");
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift", ".scala", ".php"].includes(ext)) {
    return content.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1 ");
  }
  return content;
}

function isDistinctiveLiteral(literal: string): boolean {
  if (!/[A-Za-z]{3}/.test(literal)) return false;
  if (literal.includes("{")) return false; // format strings: their identifiers are indexed separately
  if (/^[\w.-]+\.(?:py|ts|js|json|txt|csv|md)$/.test(literal)) return true; // file names
  return literal
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .some((w) => w.length > 3 && !isCommonPart(w.toLowerCase()) && /[a-z]/.test(w));
}

async function listTextFiles(ws: Workspace): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(abs);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        out.push(abs);
      }
    }
  };
  await walk(ws.root);
  return out.sort();
}

function projectNamesFrom(file: string, content: string): string[] {
  const names: string[] = [];
  const name = basename(file);
  if (name === "package.json") {
    try {
      const pkg = JSON.parse(content) as { name?: unknown };
      if (typeof pkg.name === "string") names.push(pkg.name.replace(/^@[^/]+\//, ""));
    } catch {
      // not valid JSON; ignore
    }
  } else if (name === "pyproject.toml" || name === "Cargo.toml") {
    const m = content.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}

export async function buildRepoIndex(ws: Workspace): Promise<RepoIndex> {
  const identifiers = new Map<string, string>();
  const literals = new Set<string>();
  const fragments = new FragmentIndex(REPO_FRAGMENT_WINDOW, REPO_FRAGMENT_STRIDE);
  // The directory name is a project name unless it is generic ("workspace", "repo", "app").
  const dirName = basename(ws.root);
  const projectNames = new Set<string>(identifierParts(dirName).some((p) => !isCommonPart(p)) ? [dirName] : []);
  const files: string[] = [];
  let total = 0;

  for (const abs of await listTextFiles(ws)) {
    const size = (await stat(abs)).size;
    if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) continue;
    total += size;
    const content = await readFile(abs, "utf8");
    const rel = ws.display(abs);
    files.push(rel);
    fragments.add(content, rel);
    for (const n of projectNamesFrom(abs, content)) projectNames.add(n);
    const ext = extname(rel).toLowerCase();
    if (!PROSE_EXTENSIONS.has(ext)) {
      for (const m of stripComments(content, ext).matchAll(IDENTIFIER_RE)) {
        if (isDistinctiveIdentifier(m[0])) identifiers.set(canonicalIdentifier(m[0]), m[0]);
      }
    }
    for (const m of content.matchAll(LITERAL_RE)) {
      const lit = m[2]!;
      if (isDistinctiveLiteral(lit)) literals.add(lit.toLowerCase());
    }
    // Module and file names are identifiers too (`surge_pricing.py`).
    const stem = basename(rel, extname(rel));
    if (isDistinctiveIdentifier(stem)) identifiers.set(canonicalIdentifier(stem), stem);
  }
  // "fleetwise-pricing" is also known as "fleetwise": add distinctive parts of each name.
  for (const name of [...projectNames]) {
    for (const part of name.split(/[^A-Za-z0-9]+/)) {
      if (part.length >= 4 && !isCommonPart(part.toLowerCase())) projectNames.add(part);
    }
  }
  return { identifiers, literals, fragments, projectNames: [...projectNames].filter((n) => n.length >= 3), files };
}
