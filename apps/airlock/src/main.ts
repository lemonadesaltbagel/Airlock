#!/usr/bin/env node
import { parseArgs } from "node:util";
import {
  assertProfileAllowed,
  attachStuckDetector,
  buildModels,
  createAirlockAgent,
  createCodingTools,
  createWorkspace,
  getProfile,
  PROFILES,
  ProfileNotAllowedError,
  type Profile,
} from "@airlock/agent";
import { personaCandidates } from "@airlock/broker";
import { describePolicy, findPolicy } from "@airlock/policy-data";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createConsultTools } from "./consult-setup.js";
import { initProject } from "./init.js";

const HELP = `airlock — private project agent (preview)

Usage:
  airlock run [--profile local|dev-cloud] [--dev-cloud] [--role loop|quality] [--cwd DIR]
              [--no-consult | --approve-consults ask|jewels|auto|never] <task...>
  airlock init [--cwd DIR] [--persona TEXT | --no-persona] [--force]
                                        Create .airlock/ policy files (public profile, cover setting, crown jewels)
  airlock policy <provider> <model>     Show the data policy Airlock has on record for a model
  airlock profiles                      List model profiles

Profiles:
  local      the agent's own models run on this machine (needs llama-server on ${PROFILES.local.localServer?.baseUrl})
  dev-cloud  cloud models stand in for local ones; synthetic/public projects only (needs --dev-cloud
             and a .airlock/dev-cloud-ok marker in the project; reads ANTHROPIC_API_KEY)

Consults: the agent may ask a frontier model (${PROFILES.local.consultant.provider}/${PROFILES.local.consultant.model}) for help. The question is
abstracted and checked locally first, and you see the exact text before it is sent (--approve-consults ask,
the default). With "jewels", only consults about files in .airlock/jewels.json ask first; crown-jewel
consults always ask unless consults are off. Consults read ANTHROPIC_API_KEY in every profile.

No sandbox yet: commands the agent runs have your user's permissions. Use test projects only.`;

function warn(line: string) {
  process.stderr.write(`${line}\n`);
}

function printPolicy(provider: string, modelId: string) {
  const policy = findPolicy(provider, modelId);
  if (policy) for (const line of describePolicy(policy)) warn(`airlock:   ${line}`);
  else warn(`airlock: ! no verified data policy on record for ${provider}/${modelId}`);
}

function printBanner(profile: Profile, provider: string, modelId: string, consults: boolean) {
  warn(`airlock: profile ${profile.name}, model ${provider}/${modelId}`);
  warn("airlock: ! preview — no sandbox yet; the agent's commands run with your permissions.");
  if (profile.name === "dev-cloud") {
    warn("airlock: ! dev-cloud sends this whole project to the cloud. Synthetic/public projects only.");
    printPolicy(provider, modelId);
  }
  if (consults) {
    warn(`airlock: consultant ${profile.consultant.provider}/${profile.consultant.model} receives abstracted questions:`);
    printPolicy(profile.consultant.provider, profile.consultant.model);
  }
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
  const profile = getProfile(values.profile);
  const workspaceRoot = values.cwd ?? process.cwd();
  assertProfileAllowed(profile.name, workspaceRoot, { devCloudFlag: values["dev-cloud"] });

  const models = buildModels(profile);
  const consult = values["no-consult"]
    ? undefined
    : await createConsultTools({ profile, workspace: createWorkspace(workspaceRoot), models, approval, log: warn });
  const { agent, model } = createAirlockAgent({
    workspaceRoot,
    profile,
    role: values.role,
    models,
    tools: (ws) => [...createCodingTools(ws), ...(consult?.tools(ws) ?? [])],
    onBlockedRequest: (m, reason) => warn(`airlock: blocked request to ${m.provider}/${m.id}: ${reason}`),
  });
  printBanner(profile, model.provider, model.id, consult !== undefined);
  // When the agent keeps failing its tests, tell it to consult (a local message; the consult itself
  // still goes through abstraction, the gate and the user's approval). Small local models tend to
  // ignore suggestions, so the detector asks for a consult outright.
  if (consult) attachStuckDetector(agent, { mode: "require", failedTestThreshold: 2 });
  if (consult) {
    const how = { ask: "need your approval", jewels: "about crown-jewel files need your approval, others are sent without asking", auto: "are sent without asking (except crown-jewel consults)", never: "are disabled" }[approval];
    warn(`airlock: consults ${how}; log: ${consult.logPath}`);
  }

  agent.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") process.stdout.write(event.assistantMessageEvent.delta);
        break;
      case "tool_execution_start":
        warn(`\n▸ ${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`);
        break;
      case "tool_execution_end":
        if (event.isError) warn(`  ✗ ${event.toolName} failed`);
        break;
    }
  });

  process.once("SIGINT", () => {
    warn("\nairlock: aborting…");
    agent.abort();
  });

  await agent.prompt(task);
  process.stdout.write("\n");
  const error = agent.state.errorMessage;
  if (error) {
    warn(`airlock: run ended with an error: ${error}`);
    if (model.provider === "local" && /connection/i.test(error)) {
      warn(`airlock: is the local model server running on ${model.baseUrl}?`);
    } else if (/not configured: anthropic/i.test(error)) {
      warn("airlock: set ANTHROPIC_API_KEY to your own Anthropic API key.");
    }
    return 1;
  }
  return 0;
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
    if (err instanceof ProfileNotAllowedError) warn(`airlock: ${err.message}`);
    else warn(`airlock: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  },
);
