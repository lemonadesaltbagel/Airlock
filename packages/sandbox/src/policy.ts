import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * What the sandboxed agent tree may touch. The agent and every process it starts (bash, test
 * runners, package managers) inherit the sandbox.
 */
export interface SandboxPolicyOptions {
  workspaceRoot: string;
  /** Per-session scratch directory: writable, and used as TMPDIR inside the sandbox. */
  sessionTmp: string;
  /** Directories holding the code the sandbox runs (Airlock itself, the Node binary's prefix). Read-only. */
  runtimeRoots: string[];
  /** Airlock's own data (log, keys, user id). Never readable inside the sandbox. */
  privateDirs: string[];
  /** host:port destinations reachable through the sandbox proxy without asking (the gateway). */
  allowedHosts: string[];
  /** Extra read-only paths the user allowed (CLI flag or user-level config; never project files). */
  extraReadable?: string[];
  home?: string;
}

/**
 * Paths under the home directory that commands need to run: toolchain installs (compilers,
 * interpreters, version managers, user-installed Python packages) and the text-encoding setting
 * every macOS process reads. Binaries and package stores only: files that commonly hold credentials
 * (~/.cargo/credentials.toml, ~/.npmrc, ~/.m2/settings.xml, ~/.gradle/gradle.properties) stay
 * unreadable.
 */
export const TOOLCHAIN_DIRS = [
  ".CFUserTextEncoding",
  "Library/Python",
  ".local/lib",
  ".nvm",
  ".volta",
  ".fnm",
  ".asdf/installs",
  ".asdf/shims",
  ".local/share/mise/installs",
  ".local/share/mise/shims",
  ".cargo/bin",
  ".cargo/registry",
  ".rustup",
  ".pyenv/versions",
  ".pyenv/shims",
  ".rbenv/versions",
  ".rbenv/shims",
  ".bun/bin",
  ".deno/bin",
  "go/pkg/mod",
  ".local/bin",
  "Library/pnpm",
];

/**
 * Workspace files that something outside the sandbox later runs or loads without the user
 * explicitly asking (git, direnv, editors, shells, agent tools): writing one would hand code to an
 * unsandboxed process. srt protects these only beneath its own cwd, so they are listed here against
 * the workspace explicitly.
 */
export const AUTORUN_FILES = [".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".envrc", ".ripgreprc", ".mcp.json"];
export const AUTORUN_DIRS = [".git/hooks", ".husky", ".vscode", ".idea", ".zed", ".cursor", ".claude", ".airlock"];
const AUTORUN_GIT_FILES = [".git/config", ".git/info/attributes"];

function autorunDenies(workspace: string): string[] {
  const top = [...AUTORUN_FILES, ...AUTORUN_DIRS, ...AUTORUN_GIT_FILES].map((p) => join(workspace, p));
  // Nested repositories and packages carry the same files.
  const nested = [...AUTORUN_FILES.map((f) => `**/${f}`), ...AUTORUN_DIRS.map((d) => `**/${d}/**`), ...AUTORUN_GIT_FILES.map((f) => `**/${f}`)].map((g) => `${workspace}/${g}`);
  return [...top, ...nested];
}

export class SandboxPolicyError extends Error {
  override name = "SandboxPolicyError";
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

export function buildSandboxConfig(opts: SandboxPolicyOptions): SandboxRuntimeConfig {
  const home = resolve(opts.home ?? homedir());
  const workspace = resolve(opts.workspaceRoot);
  const privateDirs = opts.privateDirs.map((p) => resolve(p));
  // A workspace that contains the home directory (or Airlock's data) would re-open everything.
  if (/[*?[\]]/.test(workspace)) throw new SandboxPolicyError(`refusing to sandbox ${workspace}: glob characters in the workspace path are not supported`);
  if (isInside(home, workspace)) throw new SandboxPolicyError(`refusing to sandbox ${workspace}: it contains the home directory`);
  for (const dir of privateDirs) {
    if (isInside(dir, workspace) || isInside(workspace, dir)) {
      throw new SandboxPolicyError(`refusing to sandbox ${workspace}: it overlaps Airlock's private data in ${dir}`);
    }
  }
  const toolchains = TOOLCHAIN_DIRS.map((d) => join(home, d)).filter((p) => existsSync(p));
  const readable = [workspace, resolve(opts.sessionTmp), ...opts.runtimeRoots.map((p) => resolve(p)), ...toolchains, ...(opts.extraReadable ?? []).map((p) => resolve(p))];
  for (const path of readable) {
    for (const dir of privateDirs) {
      if (isInside(dir, path)) throw new SandboxPolicyError(`readable path ${path} would expose Airlock's private data in ${dir}`);
    }
  }
  return {
    network: {
      allowedDomains: [...opts.allowedHosts],
      deniedDomains: [],
      allowLocalBinding: false,
    },
    filesystem: {
      // All home directories are unreadable (other users' included), then the workspace, the
      // runtime and toolchains are re-opened read-only. Private dirs are denied again explicitly
      // in case they live outside the home directory.
      denyRead: [dirname(home), ...privateDirs],
      allowRead: readable,
      allowWrite: [workspace, resolve(opts.sessionTmp)],
      // Includes the project's Airlock policy files: the agent may read but never change them.
      denyWrite: autorunDenies(workspace),
    },
    allowAppleEvents: false,
    enableWeakerNetworkIsolation: false,
    allowPty: false,
    // Known denials that are harmless and expected, not worth a log line: sysctls macOS system
    // libraries probe, and xcrun's tool-path cache in the per-user temp dir (rightly denied: it is
    // read later by processes outside the sandbox).
    ignoreViolations: { "*": ["sysctl-read kern.iossupportversion", "sysctl-read vfs.nspace.prevent_materialization", "/T/xcrun_db"] },
  };
}
