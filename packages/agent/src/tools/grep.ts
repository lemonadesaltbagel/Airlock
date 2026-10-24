import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Workspace } from "../workspace.js";
import { looksBinary } from "./file-tools.js";
import { textResult } from "./result.js";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__", "target"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULTS = 200;
const MAX_MATCH_CHARS = 300;

/** Minimal glob: `*` (no slash), `**` (any depth), `?`. Matched against workspace-relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // A glob without a slash matches the basename at any depth, like ripgrep's -g.
  return new RegExp(glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}

const grepParams = Type.Object({
  pattern: Type.String({ description: "JavaScript regular expression to search for." }),
  path: Type.Optional(Type.String({ description: "Directory or file to search, relative to the workspace root (default: root)." })),
  glob: Type.Optional(Type.String({ description: 'Only search files matching this glob, e.g. "*.ts" or "src/**/*.py".' })),
  ignore_case: Type.Optional(Type.Boolean()),
  max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
});

export function grepTool(ws: Workspace): AgentTool<typeof grepParams> {
  return {
    name: "grep",
    label: "Search files",
    description: "Search workspace files for a regex. Skips .git, node_modules and binary files. Does not follow symlinks.",
    parameters: grepParams,
    executionMode: "parallel",
    async execute(_id, { pattern, path = ".", glob, ignore_case = false, max_results = DEFAULT_MAX_RESULTS }, signal) {
      const regex = new RegExp(pattern, ignore_case ? "i" : "");
      const globRe = glob ? globToRegExp(glob) : undefined;
      const start = ws.resolveRead(path);
      const results: string[] = [];
      let truncated = false;

      const searchFile = async (abs: string) => {
        const rel = ws.display(abs);
        if (globRe && !globRe.test(rel)) return;
        const info = await stat(abs);
        if (info.size > MAX_FILE_BYTES) return;
        const buf = await readFile(abs);
        if (looksBinary(buf)) return;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!regex.test(lines[i]!)) continue;
          if (results.length >= max_results) {
            truncated = true;
            return;
          }
          results.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, MAX_MATCH_CHARS)}`);
        }
      };

      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (signal?.aborted || truncated) return;
          const abs = join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) await walk(abs);
          } else if (entry.isFile()) {
            await searchFile(abs);
          }
        }
      };

      if ((await stat(start)).isDirectory()) await walk(start);
      else await searchFile(start);

      const text = results.length ? results.join("\n") : "No matches.";
      return textResult(truncated ? `${text}\n… results truncated at ${max_results}` : text, {
        matches: results.length,
        truncated,
      });
    },
  };
}
