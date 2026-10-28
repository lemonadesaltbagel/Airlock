#!/usr/bin/env node
import { parseArgs } from "node:util";
import { assertProfileAllowed, getProfile, PROFILES, ProfileNotAllowedError } from "@airlock/agent";
import { personaCandidates } from "@airlock/broker";
import { airlockDataDir, describeEntry, LedgerIntegrityError, LedgerLockedError, loadOrCreateLedgerKey, readLedger, workspaceLogDir } from "@airlock/ledger";
import { describePolicy, findPolicy } from "@airlock/policy-data";
import { runCanary, sandboxAvailability, SandboxPolicyError } from "@airlock/sandbox";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { initProject } from "./init.js";
import { terminalPrompter } from "./prompter.js";
import { runSession } from "./session.js";

const HELP = `airlock — private project agent (preview)

Usage:
  airlock run [--profile local|dev-cloud|dev-cloud-deepseek] [--dev-cloud] [--role loop|quality] [--cwd DIR]
              [--no-consult | --approve-consults ask|jewels|auto|never]
              [--allow-host HOST[:PORT]]... [--allow-read PATH]... [--unsandboxed] <task...>
  airlock init [--cwd DIR] [--persona TEXT | --no-persona] [--force]
                                        Create .airlock/ policy files (public profile, cover setting, crown jewels)
  airlock log [--cwd DIR] [--limit N | --all] [--json]
                                        Show what left this machine for a project (encrypted, tamper-evident log)
  airlock doctor                        Check that the OS sandbox blocks every known way out
  airlock policy <provider> <model>     Show the data policy Airlock has on record for a model
  airlock profiles                      List model profiles

Profiles:
  local               the agent's own models run on this machine (needs llama-server on ${PROFILES.local.localServer?.baseUrl},
                      or set AIRLOCK_LOCAL_URL to its address)
  dev-cloud           cloud models (Anthropic) stand in for local ones; synthetic/public projects only
  dev-cloud-deepseek  the same with cheaper DeepSeek models
                      (dev-cloud profiles need --dev-cloud and a .airlock/dev-cloud-ok marker in the project)

Sandbox: the agent and every command it runs are confined by the OS sandbox (Seatbelt on macOS,
bubblewrap on Linux). They can write only inside the project, cannot read your home directory, and
have no network except Airlock's gateway, which holds the API keys. Other hosts are denied unless you
allow them for the session when asked, or with --allow-host.

Consults: the agent may ask a frontier model (${PROFILES.local.consultant.provider}/${PROFILES.local.consultant.model}) for help. The question is
abstracted and checked locally first, and you see the exact text before it is sent (--approve-consults ask,
the default). With "jewels", only consults about files in .airlock/jewels.json ask first; crown-jewel
consults always ask unless consults are off. Keys are read from your environment (ANTHROPIC_API_KEY,
DEEPSEEK_API_KEY) by the gateway only.`;

function warn(line: string) {
  process.stderr.write(`${line}\n`);
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      profile: { type: "string", default: "local" },
      "dev-cloud": { type: "boolean", default: false },
      role: { type: "string", default: "loop" },
      cwd: { type: "string" },
      "no-consult": { type: "boolean", default: false },
      "approve-consults": { type: "string", default: "ask" },
      "allow-host": { type: "string", multiple: true, default: [] },
      "allow-read": { type: "string", multiple: true, default: [] },
      unsandboxed: { type: "boolean", default: false },
    },
  });
  const approval = values["approve-consults"];
  if (approval !== "ask" && approval !== "jewels" && approval !== "auto" && approval !== "never") {
    warn(`airlock run: --approve-consults must be ask, jewels, auto or never`);
    return 2;
  }
  const task = positionals.join(" ").trim();
  if (!task) {
    warn("airlock run: missing task\n\n" + HELP);
    return 2;
  }
  if (values.role !== "loop" && values.role !== "quality") {
    warn(`airlock run: --role must be "loop" or "quality"`);
    return 2;
  }
  const base = getProfile(values.profile);
  // A local model server on another address (it must be on loopback).
  const localUrl = process.env.AIRLOCK_LOCAL_URL;
  const profile = localUrl && base.localServer ? { ...base, localServer: { ...base.localServer, baseUrl: localUrl } } : base;
  const workspaceRoot = values.cwd ?? process.cwd();
  assertProfileAllowed(profile.name, workspaceRoot, { devCloudFlag: values["dev-cloud"] });
  return runSession({
    task,
    profile,
    role: values.role,
    workspaceRoot,
    consult: !values["no-consult"],
    approval,
    unsandboxed: values.unsandboxed,
    allowHosts: values["allow-host"],
    allowRead: values["allow-read"],
    prompter: terminalPrompter(warn),
    print: warn,
  });
}

function log(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      cwd: { type: "string" },
      limit: { type: "string", default: "50" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const root = realpathSync(values.cwd ?? process.cwd());
  const dataDir = airlockDataDir();
  const path = join(workspaceLogDir(dataDir, root), "ledger.jsonl");
  if (!existsSync(path)) {
    warn(`airlock log: nothing has been logged for ${root}`);
    return 0;
  }
  const { key } = loadOrCreateLedgerKey({ dataDir });
  let entries;
  try {
    entries = readLedger(path, key);
  } catch (err) {
    if (err instanceof LedgerIntegrityError) {
      warn(`airlock log: ! the log for ${root} fails verification: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const limit = Number(values.limit);
  const shown = values.all || !Number.isFinite(limit) ? entries : entries.slice(-limit);
  if (values.json) process.stdout.write(shown.map((e) => JSON.stringify(e)).join("\n") + "\n");
  else process.stdout.write(shown.map(describeEntry).join("\n") + "\n");
  warn(`airlock log: ${entries.length} entries, chain verified (${path})`);
  return 0;
}

async function doctor(): Promise<number> {
  const availability = sandboxAvailability();
  if (!availability.ok) {
    warn(`airlock doctor: ✗ the OS sandbox is unavailable: ${availability.reason}`);
    return 1;
  }
  process.stdout.write("Running the egress canary in the OS sandbox…\n");
  const report = await runCanary({
    onOutcome: (o) => process.stdout.write(`  ${o.passed ? "✓" : "✗"} ${o.probe.expect === "allowed" ? "works:  " : "blocked:"} ${o.probe.what}\n`),
  });
  const failed = report.outcomes.filter((o) => !o.passed);
  for (const f of failed) warn(`airlock doctor: ✗ ${f.probe.id}: ${f.result.output.trim().slice(0, 300)}`);
  for (const f of report.leftovers) warn(`airlock doctor: ✗ a probe created ${f} outside the sandbox`);
  const ok = failed.length === 0 && report.leftovers.length === 0;
  process.stdout.write(ok ? `All ${report.outcomes.length} checks passed.\n` : `${failed.length} check(s) failed.\n`);
  return ok ? 0 : 1;
}

async function choosePersona(): Promise<string> {
  const candidates = personaCandidates(3);
  if (!process.stdin.isTTY) return candidates[0]!;
  const out = (line: string) => process.stdout.write(line + "\n");
  out("Pick a cover setting for consult questions: the one LEAST like your real project.");
  out("(A setting that resembles your project can give away what it does.)");
  candidates.forEach((c, i) => out(`  ${i + 1}. ${c}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Choice [1]: ")).trim();
    const idx = answer === "" ? 0 : Number(answer) - 1;
    return candidates[Number.isInteger(idx) && idx >= 0 && idx < candidates.length ? idx : 0]!;
  } finally {
    rl.close();
  }
}

async function init(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cwd: { type: "string" },
      persona: { type: "string" },
      "no-persona": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });
  const root = values.cwd ?? process.cwd();
  const needsChoice = !values["no-persona"] && values.persona === undefined && (values.force || !existsSync(join(root, ".airlock/profile.md")));
  const persona = values["no-persona"] ? false : (values.persona ?? (needsChoice ? await choosePersona() : undefined));
  const r = initProject({ root, ...(persona !== undefined ? { persona } : {}), force: values.force });
  const out = (line: string) => process.stdout.write(line + "\n");
  out(r.wroteProfile ? `Wrote ${r.profilePath}` : `Kept existing ${r.profilePath} (use --force to replace it)`);
  if (r.persona) {
    out("");
    out("Cover setting for consults:");
    out(`  ${r.persona}`);
    out("");
    out("When the agent asks an outside expert for help, Airlock rewrites the question as a generic example and");
    out("tells it in this fictional setting, so a history of questions does not point back to your project.");
    out("The technical question itself is never changed. Topics such as security exploitation or weapons are");
    out("never given a cover story. Edit or delete the COVER SETTING line in the profile at any time, or run");
    out("`airlock init --force --no-persona` to turn it off.");
  } else {
    out("No cover setting: consult questions are rewritten generically, without a fictional setting.");
  }
  out("");
  out(r.wroteJewels ? `Wrote ${r.jewelsPath}: list your crown jewels there (names, files, ideas).` : `Kept existing ${r.jewelsPath}.`);
  return 0;
}

function policy(argv: string[]): number {
  const [provider, modelId] = argv;
  if (!provider || !modelId) {
    warn("usage: airlock policy <provider> <model>");
    return 2;
  }
  const found = findPolicy(provider, modelId);
  if (!found) {
    warn(`No verified data policy on record for ${provider}/${modelId}. Treat it as unknown, not as safe.`);
    return 1;
  }
  process.stdout.write(describePolicy(found).join("\n") + "\n");
  return 0;
}

function profiles(): number {
  for (const p of Object.values(PROFILES)) {
    const roles = Object.entries(p.roles)
      .map(([role, ref]) => `${role}=${ref.provider}/${ref.model}`)
      .join("  ");
    process.stdout.write(`${p.name.padEnd(10)} ${roles}  consultant=${p.consultant.provider}/${p.consultant.model}\n`);
  }
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "run":
      return run(rest);
    case "init":
      return init(rest);
    case "log":
      return log(rest);
    case "doctor":
      return doctor();
    case "policy":
      return policy(rest);
    case "profiles":
      return profiles();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP + "\n");
      return 0;
    default:
      warn(`airlock: unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ProfileNotAllowedError || err instanceof SandboxPolicyError || err instanceof LedgerLockedError) warn(`airlock: ${err.message}`);
    else warn(`airlock: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  },
);
