import { realpathSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Paths inside the workspace the agent may never write. `.airlock/` holds the user's
 * policy (crown jewels, profile, the dev-cloud marker); letting the agent edit it would
 * let it grant itself permissions. `.git/hooks` and `.git/config` run code outside the
 * agent later ("trusted handoff" escapes).
 */
const WRITE_DENIED_PREFIXES = [".airlock", ".git/hooks", ".git/config"];

export class WorkspaceError extends Error {
  override name = "WorkspaceError";
}

export interface Workspace {
  /** Canonical (symlink-resolved) absolute root. */
  readonly root: string;
  /** Resolve a path for reading. Throws if it escapes the root. */
  resolveRead(path: string): string;
  /** Resolve a path for writing. Throws if it escapes the root or hits a denied path. */
  resolveWrite(path: string): string;
  /** Path relative to the root, with forward slashes, for display. */
  display(absPath: string): string;
}

export function createWorkspace(root: string): Workspace {
  if (!existsSync(root)) throw new WorkspaceError(`workspace root does not exist: ${root}`);
  const canonicalRoot = realpathSync(root);

  const isInside = (abs: string) => abs === canonicalRoot || abs.startsWith(canonicalRoot + sep);

  // Resolve symlinks on the longest existing prefix so a link inside the workspace
  // pointing outside it is caught, including for files that don't exist yet.
  const canonicalize = (path: string): string => {
    const abs = isAbsolute(path) ? resolve(path) : resolve(canonicalRoot, path);
    let existing = abs;
    const missing: string[] = [];
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) break;
      missing.unshift(existing.slice(parent.length + 1));
      existing = parent;
    }
    const real = existsSync(existing) ? realpathSync(existing) : existing;
    return missing.length ? resolve(real, ...missing) : real;
  };

  const toRelative = (abs: string) => relative(canonicalRoot, abs).split(sep).join("/");

  const resolveRead = (path: string): string => {
    const abs = canonicalize(path);
    if (!isInside(abs)) throw new WorkspaceError(`path is outside the workspace: ${path}`);
    return abs;
  };

  return {
    root: canonicalRoot,
    resolveRead,
    resolveWrite(path) {
      const abs = resolveRead(path);
      // Lower-cased because macOS and Windows file systems are case-insensitive by default:
      // ".Airlock/x" must not slip past the ".airlock" rule.
      const rel = toRelative(abs).toLowerCase();
      for (const denied of WRITE_DENIED_PREFIXES) {
        if (rel === denied || rel.startsWith(denied + "/")) {
          throw new WorkspaceError(`writing to ${denied} is not allowed: ${path}`);
        }
      }
      return abs;
    },
    display: toRelative,
  };
}
