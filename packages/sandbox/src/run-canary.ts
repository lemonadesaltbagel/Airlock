import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CANARY_PROBES, probeReached, type CanaryContext, type CanaryProbe, type ProbeResult } from "./canary.js";
import { buildSandboxConfig } from "./policy.js";
import { startSandbox } from "./srt.js";

export interface CanaryOutcome {
  probe: CanaryProbe;
  passed: boolean;
  result: ProbeResult;
}

export interface CanaryReport {
  outcomes: CanaryOutcome[];
  /** Hosts the sandbox asked the egress decider about (all denied). */
  asked: string[];
  /** Files the probes tried to create outside the sandbox and that exist afterwards. */
  leftovers: string[];
}

const SECRET_VAR = "AIRLOCK_CANARY_SECRET";

function listen<T extends HttpServer | Server>(server: T, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    (server.listen as (...a: unknown[]) => void)(...args, () => resolve(server));
  });
}

/**
 * Runs every canary probe inside a sandbox built by the same policy `airlock run` uses, against a
 * throwaway workspace, a gateway stand-in, a loopback service, a Unix socket and planted files.
 */
export async function runCanary(opts: { onOutcome?: (o: CanaryOutcome) => void } = {}): Promise<CanaryReport> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-canary-")));
  const workspace = join(root, "ws");
  const sessionTmp = join(root, "tmp");
  const privateDir = join(root, "private");
  const homeFile = join(homedir(), `.airlock-canary-${process.pid}`);
  const homeWriteTarget = join(homedir(), `.airlock-canary-write-${process.pid}`);
  const outsideWriteTarget = join(root, "outside.txt");
  const servers: (HttpServer | Server)[] = [];
  const asked: string[] = [];
  const previousSecret = process.env[SECRET_VAR];
  let sandbox: Awaited<ReturnType<typeof startSandbox>> | undefined;
  try {
    for (const d of [workspace, join(workspace, ".git/hooks"), join(workspace, ".airlock"), sessionTmp, privateDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(workspace, ".git/config"), "[core]\n");
    writeFileSync(join(workspace, ".airlock/jewels.json"), "{}\n");
    writeFileSync(join(privateDir, "log.key"), "canary-secret-key\n");
    writeFileSync(homeFile, "canary home secret\n");

    const gateway = await listen(createHttpServer((_req, res) => res.end("gateway")), 0, "127.0.0.1");
    const service = await listen(createHttpServer((_req, res) => res.end("local service")), 0, "127.0.0.1");
    const unixSocketPath = join(workspace, "daemon.sock");
    servers.push(gateway, service, await listen(createServer((s) => s.end("daemon")), unixSocketPath));
    const gatewayPort = (gateway.address() as { port: number }).port;

    sandbox = await startSandbox(
      buildSandboxConfig({
        workspaceRoot: workspace,
        sessionTmp,
        runtimeRoots: [dirname(dirname(realpathSync(process.execPath)))],
        privateDirs: [privateDir],
        allowedHosts: [`127.0.0.1:${gatewayPort}`],
      }),
      async (host, port) => {
        asked.push(`${host}:${port}`);
        return false;
      },
    );
    process.env[SECRET_VAR] = "parent-only";
    const ctx: CanaryContext = {
      node: realpathSync(process.execPath),
      workspace,
      gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
      localServicePort: (service.address() as { port: number }).port,
      unixSocketPath,
      homeFile,
      privateFile: join(privateDir, "log.key"),
      homeWriteTarget,
      outsideWriteTarget,
      parentSecretVar: SECRET_VAR,
    };
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: "C" };
    const outcomes: CanaryOutcome[] = [];
    for (const probe of CANARY_PROBES) {
      if (probe.platforms && !probe.platforms.includes(process.platform)) continue;
      const child = await sandbox.spawn(probe.command(ctx), { cwd: workspace, env });
      let output = "";
      child.stdout?.on("data", (d) => (output += d));
      child.stderr?.on("data", (d) => (output += d));
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      const result = { code, output };
      const outcome = { probe, passed: probeReached(result) === (probe.expect === "allowed"), result };
      outcomes.push(outcome);
      opts.onOutcome?.(outcome);
    }
    return { outcomes, asked, leftovers: [homeWriteTarget, outsideWriteTarget].filter((f) => existsSync(f)) };
  } finally {
    if (previousSecret === undefined) delete process.env[SECRET_VAR];
    else process.env[SECRET_VAR] = previousSecret;
    await sandbox?.stop();
    for (const s of servers) s.close();
    for (const f of [homeFile, homeWriteTarget]) rmSync(f, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
}
