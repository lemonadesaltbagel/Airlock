import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { globToRegExp, type Workspace } from "@airlock/agent";
import { FragmentIndex } from "./fragment-index.js";

export const JEWELS_FILE = ".airlock/jewels.json";

/** Crown-jewel fragments of ≥ 31 normalized characters are caught. */
export const JEWEL_FRAGMENT_WINDOW = 24;
export const JEWEL_FRAGMENT_STRIDE = 8;

/** User-declared secrets, stored in `.airlock/jewels.json` (agent-unwritable). */
export interface JewelsConfig {
  /** Exact strings that must never leave: names, codenames, constants. Case-insensitive. */
  terms?: string[];
  /** Globs of files whose content is a crown jewel (fingerprinted). */
  files?: string[];
  /** Natural-language descriptions of the secret ideas. Used by attackers/shadow attacker, not the gate. */
  descriptions?: string[];
}

export interface Jewels {
  terms: string[];
  descriptions: string[];
  fragments: FragmentIndex;
  /** Workspace-relative paths of the files declared as crown jewels. */
  files: Set<string>;
}

/** Whether a consult is about crown-jewel code: any referenced file is a declared jewel file. */
export function touchesJewels(jewels: Jewels, files: readonly string[]): boolean {
  return files.some((f) => jewels.files.has(f.replace(/^\.\//, "")));
}

export function emptyJewels(): Jewels {
  return { terms: [], descriptions: [], fragments: new FragmentIndex(JEWEL_FRAGMENT_WINDOW, JEWEL_FRAGMENT_STRIDE), files: new Set() };
}

export async function loadJewels(ws: Workspace, repoFiles: readonly string[]): Promise<Jewels> {
  const jewels = emptyJewels();
  const path = join(ws.root, JEWELS_FILE);
  if (!existsSync(path)) return jewels;
  const config = JSON.parse(await readFile(path, "utf8")) as JewelsConfig;
  jewels.terms = (config.terms ?? []).map((t) => t.trim()).filter((t) => t.length >= 3);
  jewels.descriptions = config.descriptions ?? [];
  const globs = (config.files ?? []).map(globToRegExp);
  for (const rel of repoFiles) {
    if (!globs.some((g) => g.test(rel))) continue;
    jewels.fragments.add(await readFile(ws.resolveRead(rel), "utf8"), rel);
    jewels.files.add(rel);
  }
  return jewels;
}
