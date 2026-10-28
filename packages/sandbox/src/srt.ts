import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";

/** Decides a connection to a host no rule covers. Only `true` allows. */
export type EgressAsk = (host: string, port: number | undefined) => Promise<boolean>;

export interface SandboxViolation {
  line: string;
  command?: string;
  timestamp: Date;
}

export type SandboxAvailability = { ok: true } | { ok: false; reason: string };

export interface SpawnOptions {
  cwd: string;
  /** The complete environment. Nothing from Airlock's own environment is inherited. */
  env: Record<string, string>;
  stdio?: StdioOptions;
}

/**
 * The OS sandbox around the agent's whole process tree, on Anthropic's sandbox-runtime (srt):
 * Seatbelt on macOS, bubblewrap + network namespace + seccomp on Linux. The kernel denies all
 * network except srt's proxy, and the proxy allows only the configured hosts.
 */
export interface Sandbox {
  readonly backend: string;
  spawn(command: string, opts: SpawnOptions): Promise<ChildProcess>;
  violations(): SandboxViolation[];
  /** Total denials so far (the store keeps only the most recent ones). */
  violationCount(): number;
  /** Called once for each new denial. Returns an unsubscribe function. */
  onViolation(listener: (v: SandboxViolation) => void): () => void;
  stop(): Promise<void>;
}

export function sandboxAvailability(): SandboxAvailability {
  if (!SandboxManager.isSupportedPlatform()) return { ok: false, reason: `the OS sandbox is not supported on ${process.platform}` };
  if (process.platform === "win32") return { ok: false, reason: "the Windows sandbox is not supported yet" };
  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) return { ok: false, reason: deps.errors.join("; ") };
  return { ok: true };
}

/**
 * Shell prefix for a sandboxed command that must reach an allowed loopback host (the gateway)
 * from Node. srt advertises its proxy as `localhost`, which costs a resolver lookup the sandbox
 * denies, and it exempts loopback from proxying, while loopback is reachable only through the
 * proxy. So: address the proxy as 127.0.0.1, proxy everything, and make Node use the proxy.
 */
export const LOOPBACK_VIA_PROXY_PREFIX =
  `for v in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy GRPC_PROXY grpc_proxy; do ` +
  `eval "x=\\\${$v:-}"; [ -n "$x" ] && export "$v=$(printf %s "$x" | sed 's#localhost:#127.0.0.1:#')"; done; ` +
  `NO_PROXY= no_proxy= NODE_USE_ENV_PROXY=1 `;

let active = false;

/** srt keeps process-wide state, so one sandbox may be active per process. */
export async function startSandbox(config: SandboxRuntimeConfig, ask?: EgressAsk): Promise<Sandbox> {
  const availability = sandboxAvailability();
  if (!availability.ok) throw new Error(availability.reason);
  if (active) throw new Error("a sandbox is already active in this process");
  active = true;
  try {
    await SandboxManager.initialize(
      config,
      async ({ host, port }) => {
        if (!ask) return false;
        try {
          return (await ask(host, port)) === true;
        } catch {
          return false;
        }
      },
      // Record Seatbelt denials (macOS log stream) as violations, not only proxy denials.
      true,
    );
  } catch (err) {
    active = false;
    throw err;
  }
  return {
    backend: process.platform === "darwin" ? "seatbelt" : "bubblewrap",
    async spawn(command, opts) {
      const wrapped = await SandboxManager.wrapWithSandbox(command);
      return spawn(wrapped, { shell: "/bin/sh", cwd: opts.cwd, env: opts.env, stdio: opts.stdio ?? "pipe" });
    },
    violations() {
      return SandboxManager.getSandboxViolationStore()
        .getViolations()
        .map((v) => ({ line: v.line, ...(v.command ? { command: v.command } : {}), timestamp: v.timestamp }));
    },
    violationCount() {
      return SandboxManager.getSandboxViolationStore().getTotalCount();
    },
    onViolation(listener) {
      const store = SandboxManager.getSandboxViolationStore();
      let seen = store.getTotalCount();
      return store.subscribe((recent) => {
        const total = store.getTotalCount();
        const fresh = recent.slice(Math.max(0, recent.length - (total - seen)));
        seen = total;
        for (const v of fresh) listener({ line: v.line, ...(v.command ? { command: v.command } : {}), timestamp: v.timestamp });
      });
    },
    async stop() {
      await SandboxManager.reset();
      active = false;
    },
  };
}
