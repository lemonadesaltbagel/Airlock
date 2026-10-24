import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { buildModels, type Profile, type Workspace } from "@airlock/agent";
import { createAbstractor } from "@airlock/broker";
import {
  buildRepoIndex,
  consultTool,
  createConsultant,
  createConsultService,
  createGate,
  createJsonlConsultLog,
  getOrCreateUserId,
  loadJewels,
  type ConfirmFn,
} from "@airlock/consult";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";

export interface ConsultSetupOptions {
  profile: Profile;
  workspace: Workspace;
  models: Models;
  /**
   * "ask" prompts for every consult; "jewels" sends other consults without asking but always asks
   * for consults about crown-jewel files; "auto" never asks; "never" declines everything.
   */
  approval: "ask" | "jewels" | "auto" | "never";
  log: (line: string) => void;
}

/** Plaintext for now, outside every workspace. To be replaced by an encrypted log. */
export function consultLogPath(workspaceRoot: string): string {
  const key = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return join(homedir(), ".airlock", "dev-logs", key, "consults.jsonl");
}

function terminalConfirm(log: (line: string) => void): ConfirmFn {
  return async (outbound) => {
    log("\n──────── consult: this exact text will be sent ────────");
    log(outbound);
    log("────────────────────────────────────────────────────────");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question("Send this to the consultant? [y/N] ");
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}

export async function createConsultTools(opts: ConsultSetupOptions): Promise<{ tools: (ws: Workspace) => AgentTool<any>[]; logPath: string }> {
  // The consultant is never one of the agent's own roles, so its provider is set up separately.
  const consultantModels = buildModels({ ...opts.profile, roles: { loop: opts.profile.consultant, quality: opts.profile.consultant } });
  const consultantModel = consultantModels.getModel(opts.profile.consultant.provider, opts.profile.consultant.model);
  if (!consultantModel) throw new Error(`consultant model ${opts.profile.consultant.provider}/${opts.profile.consultant.model} is not available`);
  const qualityRef = opts.profile.roles.quality;
  const qualityModel = opts.models.getModel(qualityRef.provider, qualityRef.model);
  if (!qualityModel) throw new Error(`quality model ${qualityRef.provider}/${qualityRef.model} is not available`);

  const repo = await buildRepoIndex(opts.workspace);
  const jewels = await loadJewels(opts.workspace, repo.files);
  const gate = createGate(repo, jewels);
  const logPath = consultLogPath(opts.workspace.root);
  const confirm: ConfirmFn | undefined =
    opts.approval === "ask" ? terminalConfirm(opts.log) : opts.approval === "never" ? async () => false : undefined;

  const service = createConsultService({
    mode: "abstracted",
    workspace: opts.workspace,
    gate,
    consultant: createConsultant({
      models: consultantModels,
      model: consultantModel,
      ...(opts.profile.consultant.thinking ? { thinking: opts.profile.consultant.thinking } : {}),
      userId: getOrCreateUserId(),
    }),
    log: createJsonlConsultLog(logPath),
    abstractor: createAbstractor({
      models: opts.models,
      model: qualityModel,
      ...(qualityRef.thinking ? { thinking: qualityRef.thinking } : {}),
      workspace: opts.workspace,
      gate,
    }),
    ...(confirm ? { confirm } : {}),
    jewelFiles: jewels.files,
    jewelPolicy: opts.approval === "never" ? "block" : "confirm",
    confirmJewels: opts.approval === "never" ? async () => false : terminalConfirm(opts.log),
  });
  return { tools: () => [consultTool(service)], logPath };
}
