import { spawn } from "node:child_process";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { buildChildEnv } from "../env.js";
import type { Workspace } from "../workspace.js";
import { textResult } from "./result.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Output kept per stream: head and tail halves, so both the command and its final error survive. */
const MAX_OUTPUT_CHARS = 32_000;

export function truncateMiddle(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - max} chars omitted] …\n${text.slice(-half)}`;
}

export interface BashDetails {
  exitCode: number | null;
  timedOut: boolean;
}

const bashParams = Type.Object({
  command: Type.String({ description: "Command to run with bash -c, in the workspace root." }),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_TIMEOUT_MS })),
});

/**
 * Runs shell commands in the workspace root with a scrubbed environment.
 * NOT a security boundary yet: the command can still reach the network and any file
 * the user can. Containment arrives with the OS sandbox (planned).
 */
export function bashTool(ws: Workspace, env: Record<string, string> = buildChildEnv()): AgentTool<typeof bashParams, BashDetails> {
  return {
    name: "bash",
    label: "Run command",
    description: "Run a shell command in the workspace root. Non-interactive; output is truncated if very long.",
    parameters: bashParams,
    executionMode: "sequential",
    execute(_id, { command, timeout_ms = DEFAULT_TIMEOUT_MS }, signal) {
      return new Promise((resolve, reject) => {
        // detached: the command gets its own process group so timeout/abort kills its children too.
        const child = spawn("/bin/bash", ["-c", command], { cwd: ws.root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let timedOut = false;
        const killGroup = () => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGKILL");
          } catch {
            // already exited
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          killGroup();
        }, Math.min(timeout_ms, MAX_TIMEOUT_MS));
        const onAbort = () => killGroup();
        signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
        child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
        child.on("error", (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        });
        child.on("close", (exitCode) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const status = timedOut ? `timed out after ${timeout_ms} ms` : `exit code ${exitCode ?? "null (killed)"}`;
          const body = `${truncateMiddle(output)}${output.endsWith("\n") || output === "" ? "" : "\n"}[${status}]`;
          resolve({ ...textResult(body, { exitCode, timedOut }), isError: timedOut || exitCode !== 0 });
        });
      });
    },
  };
}
