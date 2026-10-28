import {
  buildChildEnv,
  buildModels,
  createWorkspace,
  isDevCloud,
  PROVIDER_KEY_ENV,
  sandboxToolEnv,
  type Profile,
} from "@airlock/agent";
import { ConsultRequestError, parseConsultRequest, type ConsultHandler, type ConsultLog } from "@airlock/consult";
import { HttpError, startGateway, type Gateway, type RelayApi, type RelayRoute } from "@airlock/gateway";
import { airlockDataDir, loadOrCreateLedgerKey, openLedger, workspaceLogDir, type Ledger } from "@airlock/ledger";
import { describePolicy, findPolicy } from "@airlock/policy-data";
import { buildSandboxConfig, diffAutorun, LOOPBACK_VIA_PROXY_PREFIX, sandboxAvailability, snapshotAutorun, startSandbox, type EgressAsk, type Sandbox } from "@airlock/sandbox";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConsultHandler } from "./consult-setup.js";
import type { Prompter } from "./prompter.js";
import { GATEWAY_TOKEN_ENV, GATEWAY_URL_ENV, type AgentSession } from "./protocol.js";

export interface SessionOptions {
  task: string;
  profile: Profile;
  role: "loop" | "quality";
  workspaceRoot: string;
  consult: boolean;
  approval: "ask" | "jewels" | "auto" | "never";
  /** Run the agent without the OS sandbox (still through the gateway). */
  unsandboxed: boolean;
  /** host or host:port entries the agent may reach without asking. */
  allowHosts: string[];
  /** Extra read-only paths for the sandbox. */
  allowRead: string[];
  prompter: Prompter;
  print: (line: string) => void;
}

const AGENT_MAIN = fileURLToPath(new URL("./agent-main.js", import.meta.url));
/** Root of the Airlock installation (the repository in a source checkout). */
const INSTALL_ROOT = resolve(dirname(AGENT_MAIN), "../../..");

/** What the sandbox may read of Airlock itself: everything but dotfiles (a checkout's .env holds keys). */
function runtimeRoots(): string[] {
  const roots = readdirSync(INSTALL_ROOT)
    .filter((name) => !name.startsWith("."))
    .map((name) => join(INSTALL_ROOT, name));
  roots.push(dirname(dirname(realpathSync(process.execPath))));
  return roots;
}

const RELAY_APIS: readonly string[] = ["anthropic-messages", "openai-completions"] satisfies RelayApi[];

/** One relay route per provider the agent's roles use, holding that provider's key. */
export function relayRoutes(profile: Profile, env: NodeJS.ProcessEnv = process.env): RelayRoute[] {
  const models = buildModels(profile);
  const byProvider = new Map<string, RelayRoute>();
  for (const ref of Object.values(profile.roles)) {
    const model = models.getModel(ref.provider, ref.model);
    if (!model) throw new Error(`model ${ref.provider}/${ref.model} is not registered`);
    if (!RELAY_APIS.includes(model.api)) throw new Error(`model ${ref.provider}/${ref.model} uses API ${model.api}, which the gateway cannot relay`);
    const existing = byProvider.get(ref.provider);
    if (existing) {
      if (!existing.allowedModels.includes(ref.model)) existing.allowedModels.push(ref.model);
      continue;
    }
    const keyVar = PROVIDER_KEY_ENV[ref.provider];
    const apiKey = keyVar ? env[keyVar] : undefined;
    if (keyVar && !apiKey) throw new Error(`set ${keyVar} to your own ${ref.provider} API key (profile ${profile.name} uses ${ref.provider}/${ref.model})`);
    byProvider.set(ref.provider, { id: ref.provider, upstreamBaseUrl: model.baseUrl, api: model.api as RelayApi, ...(apiKey ? { apiKey } : {}), allowedModels: [ref.model] });
  }
  return [...byProvider.values()];
}

function ledgerConsultLog(ledger: Ledger): ConsultLog {
  return { append: (record) => void ledger.append("consult", record) };
}

/** The user's git identity, read outside the sandbox (where ~/.gitconfig is unreadable). */
function gitIdentity(cwd: string): Record<string, string> {
  const get = (key: string) => spawnSync("git", ["config", "--get", key], { cwd, encoding: "utf8" }).stdout?.trim() ?? "";
  const name = get("user.name");
  const email = get("user.email");
  return {
    ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}),
    ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}),
  };
}

function hostMatches(host: string, port: number | undefined, entry: string): boolean {
  const [h, p] = entry.includes(":") ? [entry.slice(0, entry.lastIndexOf(":")), entry.slice(entry.lastIndexOf(":") + 1)] : [entry, undefined];
  if (p !== undefined && String(port) !== p) return false;
  return h.startsWith("*.") ? host.endsWith(h.slice(1)) : host === h;
}

/**
 * Decides connections to hosts no rule covers: allowed by --allow-host, otherwise asked once per
 * host and port (when there is a terminal) and denied by default. Every decision is logged.
 */
function egressDecider(opts: { allowHosts: string[]; prompter: Prompter; ledger: Ledger; print: (line: string) => void }): EgressAsk {
  const decided = new Map<string, Promise<boolean>>();
  return (host, port) => {
    const key = `${host}${port ? `:${port}` : ""}`;
    const cached = decided.get(key);
    if (cached) return cached;
    const decision = (async () => {
      let allow = false;
      let by: "flag" | "user" | "default" = "default";
      if (opts.allowHosts.some((e) => hostMatches(host, port, e))) {
        allow = true;
        by = "flag";
      } else if (opts.prompter.interactive) {
        allow = await opts.prompter.confirm(`airlock: the agent wants to connect to ${key}. Allow it for this session?`);
        by = "user";
      }
      opts.ledger.append("egress", { host, port, decision: allow ? "allowed" : "denied", by });
      if (!allow && by === "default") opts.print(`airlock: blocked network access to ${key} (allow it with --allow-host ${host})`);
      return allow;
    })();
    decided.set(key, decision);
    return decision;
  };
}

function printPolicy(print: (line: string) => void, provider: string, modelId: string) {
  const policy = findPolicy(provider, modelId);
  if (policy) for (const line of describePolicy(policy)) print(`airlock:   ${line}`);
  else print(`airlock: ! no verified data policy on record for ${provider}/${modelId}`);
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
  });
}

/**
 * One `airlock run`: the trusted side (gateway with the keys, consult path, egress decisions,
 * log) runs here; the agent runs in a child process inside the OS sandbox.
 */
export async function runSession(opts: SessionOptions): Promise<number> {
  const { profile, print } = opts;
  const workspaceRoot = realpathSync(opts.workspaceRoot);
  if (!opts.unsandboxed) {
    const availability = sandboxAvailability();
    if (!availability.ok) {
      print(`airlock: the OS sandbox is unavailable: ${availability.reason}`);
      print("airlock: install what it needs, or pass --unsandboxed to run without it (test projects only).");
      return 1;
    }
  }
  const relays = relayRoutes(profile);

  const dataDir = airlockDataDir();
  const { key } = loadOrCreateLedgerKey({ dataDir });
  const ledger = openLedger(join(workspaceLogDir(dataDir, workspaceRoot), "ledger.jsonl"), key);
  const sessionTmp = realpathSync(mkdtempSync(join(tmpdir(), "airlock-session-")));
  let gateway: Gateway | undefined;
  let sandbox: Sandbox | undefined;
  let exitCode = 1;
  let stopViolationLog: (() => void) | undefined;
  try {
    const consult: ConsultHandler | undefined = !opts.consult
      ? undefined
      : await createConsultHandler({
          profile,
          workspace: createWorkspace(workspaceRoot),
          models: buildModels(profile),
          approval: opts.approval,
          log: ledgerConsultLog(ledger),
          prompter: opts.prompter,
          print,
        });
    const session: AgentSession = { task: opts.task, profile: profile.name, role: opts.role, consult: consult !== undefined, workspaceRoot };
    gateway = await startGateway({
      relays,
      session,
      ...(consult
        ? {
            consult: async (body: unknown, signal: AbortSignal) => {
              let request;
              try {
                request = parseConsultRequest(body);
              } catch (err) {
                if (err instanceof ConsultRequestError) throw new HttpError(400, err.message);
                throw err;
              }
              return consult.handle(request, signal);
            },
          }
        : {}),
      onEvent: (event) => {
        if (event.type === "relay") ledger.append("relay", event);
        else if (event.type !== "consult") ledger.append("gateway", event);
      },
    });

    const ref = profile.roles[opts.role];
    print(`airlock: profile ${profile.name}, model ${ref.provider}/${ref.model}`);
    if (isDevCloud(profile.name)) {
      print("airlock: ! dev-cloud sends this whole project to the cloud. Synthetic/public projects only.");
      printPolicy(print, ref.provider, ref.model);
    }
    if (consult) {
      print(`airlock: consultant ${profile.consultant.provider}/${profile.consultant.model} receives abstracted questions:`);
      printPolicy(print, profile.consultant.provider, profile.consultant.model);
      const how = { ask: "need your approval", jewels: "about crown-jewel files need your approval, others are sent without asking", auto: "are sent without asking (except crown-jewel consults)", never: "are disabled" }[opts.approval];
      print(`airlock: consults ${how}`);
    }

    // The child's environment is built from an allowlist: none of Airlock's keys reach it. Its
    // provider key variables carry the gateway token, which the gateway swaps for the real key.
    const providerKeys = Object.fromEntries(relays.flatMap((r) => (PROVIDER_KEY_ENV[r.id] ? [[PROVIDER_KEY_ENV[r.id]!, gateway!.token]] : [])));
    const env: Record<string, string> = {
      ...buildChildEnv(process.env),
      ...sandboxToolEnv(sessionTmp),
      ...gitIdentity(workspaceRoot),
      ...providerKeys,
      TMPDIR: sessionTmp,
      [GATEWAY_URL_ENV]: gateway.url,
      [GATEWAY_TOKEN_ENV]: gateway.token,
    };
    const node = realpathSync(process.execPath);
    const autorunBefore = snapshotAutorun(workspaceRoot);
    let child: ChildProcess;
    if (opts.unsandboxed) {
      print("airlock: ! running WITHOUT the OS sandbox: the agent's commands have your permissions and network access.");
      child = spawn(node, [AGENT_MAIN], { cwd: workspaceRoot, env, stdio: ["ignore", "inherit", "inherit"] });
      ledger.append("session-start", { profile: profile.name, task: opts.task, sandbox: "none" });
    } else {
      // srt reads its temp dir from here when wrapping the command.
      process.env.CLAUDE_CODE_TMPDIR = sessionTmp;
      sandbox = await startSandbox(
        buildSandboxConfig({
          workspaceRoot,
          sessionTmp,
          runtimeRoots: runtimeRoots(),
          privateDirs: [dataDir, join(homedir(), ".airlock")],
          allowedHosts: [`127.0.0.1:${gateway.port}`],
          extraReadable: opts.allowRead,
        }),
        egressDecider({ allowHosts: opts.allowHosts, prompter: opts.prompter, ledger, print }),
      );
      print(`airlock: agent sandboxed (${sandbox.backend}): no network except the gateway; writes only in the workspace`);
      stopViolationLog = sandbox.onViolation((v) => ledger.append("violation", { line: v.line }));
      ledger.append("session-start", { profile: profile.name, task: opts.task, sandbox: sandbox.backend });
      const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
      child = await sandbox.spawn(`${LOOPBACK_VIA_PROXY_PREFIX}exec ${quote(node)} ${quote(AGENT_MAIN)}`, {
        cwd: workspaceRoot,
        env,
        stdio: ["ignore", "inherit", "inherit"],
      });
    }

    let interrupts = 0;
    const onSigint = () => {
      // The agent receives the same Ctrl-C (same process group) and aborts on its own.
      interrupts += 1;
      if (interrupts > 1) child.kill("SIGKILL");
    };
    process.on("SIGINT", onSigint);
    try {
      exitCode = await waitForExit(child);
    } finally {
      process.off("SIGINT", onSigint);
    }

    const autorunChanges = diffAutorun(autorunBefore, snapshotAutorun(workspaceRoot));
    if (autorunChanges.length > 0) {
      ledger.append("autorun", { changes: autorunChanges });
      print("airlock: ! the agent created or changed files that other programs run automatically. Review them before using git,");
      print("airlock:   your editor or your shell in this project:");
      for (const c of autorunChanges) print(`airlock:     ${c.change.padEnd(7)} ${c.path}`);
    }
    // Seatbelt reports denials through the system log a moment after they happen.
    if (sandbox) await new Promise((r) => setTimeout(r, 1500));
    stopViolationLog?.();
    const violations = sandbox?.violationCount() ?? 0;
    if (violations > 0) print(`airlock: the sandbox denied ${violations} operation(s); see \`airlock log\``);
    ledger.append("session-end", { exitCode, violations });
    return exitCode;
  } finally {
    await sandbox?.stop();
    await gateway?.close();
    ledger.close();
    rmSync(sessionTmp, { recursive: true, force: true });
  }
}
