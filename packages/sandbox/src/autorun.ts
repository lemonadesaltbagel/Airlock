import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { AUTORUN_DIRS, AUTORUN_FILES } from "./policy.js";

/**
 * After a session, which autorun files (see AUTORUN_FILES / AUTORUN_DIRS) did the agent create or
 * change? The sandbox write-protects them, but on Linux it can only protect paths that exist when
 * the session starts, so a nested repository created during the session is checked here. Runs on
 * the trusted side, on every platform, as a second line.
 */
export type AutorunSnapshot = Map<string, string>;

export interface AutorunChange {
  path: string;
  change: "added" | "changed";
}

/** Directories never descended: dependency trees and build output are not where autorun files live. */
const SKIP_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", "target", ".tox", ".mypy_cache", ".pytest_cache"]);
const MAX_ENTRIES = 200_000;

function hashFile(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "unreadable";
  }
}

export function isAutorunPath(rel: string): boolean {
  const parts = rel.split(sep);
  const name = parts[parts.length - 1]!;
  if (AUTORUN_FILES.includes(name)) return true;
  const joined = parts.join("/");
  if (/(^|\/)\.git\/(config|info\/attributes)$/.test(joined)) return true;
  return AUTORUN_DIRS.some((dir) => joined === dir || joined.startsWith(`${dir}/`) || joined.includes(`/${dir}/`));
}

export function snapshotAutorun(workspace: string): AutorunSnapshot {
  const found: AutorunSnapshot = new Map();
  let entries = 0;
  const walk = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (++entries > MAX_ENTRIES) return;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full, { throwIfNoEntry: false });
      } catch {
        continue;
      }
      if (!st) continue;
      const rel = relative(workspace, full);
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (name === ".git") {
          // Only the parts of a repository that run code: hooks, config, attributes.
          for (const p of ["config", join("info", "attributes")]) {
            const f = join(full, p);
            if (statSync(f, { throwIfNoEntry: false })?.isFile()) found.set(relative(workspace, f), hashFile(f));
          }
          walk(join(full, "hooks"));
          continue;
        }
        walk(full);
      } else if (st.isFile() && isAutorunPath(rel)) {
        found.set(rel, hashFile(full));
      }
    }
  };
  walk(workspace);
  return found;
}

export function diffAutorun(before: AutorunSnapshot, after: AutorunSnapshot): AutorunChange[] {
  const changes: AutorunChange[] = [];
  for (const [path, hash] of after) {
    const old = before.get(path);
    if (old === undefined) changes.push({ path, change: "added" });
    else if (old !== hash) changes.push({ path, change: "changed" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}
