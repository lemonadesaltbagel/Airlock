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

/** A command that prints more than this is a runaway (an endless loop, usually) and is stopped. */
const MAX_TOTAL_OUTPUT_CHARS = 10_000_000;

export function truncateMiddle(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - max} chars omitted] …\n${text.slice(-half)}`;
}

/**
 * Keeps the head and a rolling tail of a command's output, in bounded memory however much it
 * prints, and renders them the way truncateMiddle does.
 */
export class OutputCapture {
  private head = "";
  private tail = "";
  total = 0;

  constructor(private readonly max = MAX_OUTPUT_CHARS) {}

  push(chunk: string): void {
    this.total += chunk.length;
    const half = Math.floor(this.max / 2);
    if (this.head.length < half) {
      const take = chunk.slice(0, half - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > this.max) this.tail = this.tail.slice(-this.max);
  }

  text(): string {
    if (this.total <= this.max) return this.head + this.tail;
    const half = Math.floor(this.max / 2);
    return `${this.head}\n… [${this.total - this.head.length - half} chars omitted] …\n${this.tail.slice(-half)}`;
  }

  endsWithNewline(): boolean {
    return (this.tail || this.head).endsWith("\n");
  }
}

export interface BashDetails {
  exitCode: number | null;
  timedOut: boolean;
  /** Stopped for printing more than MAX_TOTAL_OUTPUT_CHARS. */
  outputLimited?: boolean;
}

const bashParams = Type.Object({
  command: Type.String({ description: "Command to run with bash -c, in the workspace root." }),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_TIMEOUT_MS })),
});

/**
 * Runs shell commands in the workspace root with a scrubbed environment. Not a boundary by
 * itself: under `airlock run` the agent and every command it starts are inside the OS sandbox.
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
        const output = new OutputCapture();
        let timedOut = false;
        let outputLimited = false;
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

        const onData = (d: Buffer) => {
          output.push(d.toString("utf8"));
          if (output.total > MAX_TOTAL_OUTPUT_CHARS && !outputLimited) {
            outputLimited = true;
            killGroup();
          }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (err) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        });
        child.on("close", (exitCode) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const status = timedOut
            ? `timed out after ${timeout_ms} ms`
            : outputLimited
              ? `stopped: printed more than ${MAX_TOTAL_OUTPUT_CHARS} characters`
              : `exit code ${exitCode ?? "null (killed)"}`;
          const text = output.text();
          const body = `${text}${output.endsWithNewline() || text === "" ? "" : "\n"}[${status}]`;
          resolve({ ...textResult(body, { exitCode, timedOut, ...(outputLimited ? { outputLimited } : {}) }), isError: timedOut || outputLimited || exitCode !== 0 });
        });
      });
    },
  };
}
