import { buildModels, type Profile, type Workspace } from "@airlock/agent";
import { createAbstractor } from "@airlock/broker";
import {
  buildRepoIndex,
  createConsultant,
  createConsultService,
  createGate,
  getOrCreateUserId,
  loadJewels,
  serviceHandler,
  type ConfirmFn,
  type ConsultHandler,
  type ConsultLog,
} from "@airlock/consult";
import type { Models } from "@earendil-works/pi-ai";
import type { Prompter } from "./prompter.js";

export interface ConsultSetupOptions {
  profile: Profile;
  workspace: Workspace;
  /** Models for the abstraction step (the profile's quality role), called from the trusted side. */
  models: Models;
  /**
   * "ask" prompts for every consult; "jewels" sends other consults without asking but always asks
   * for consults about crown-jewel files; "auto" never asks; "never" declines everything.
   */
  approval: "ask" | "jewels" | "auto" | "never";
  log: ConsultLog;
  prompter: Prompter;
  print: (line: string) => void;
}

function terminalConfirm(prompter: Prompter, print: (line: string) => void): ConfirmFn {
  return async (outbound) => {
    if (!prompter.interactive) {
      print("airlock: a consult needs your approval, but there is no terminal to ask on; declined.");
      return false;
    }
    return prompter.confirm(
      "Send this to the consultant?",
      ["", "──────── consult: this exact text will be sent ────────", outbound, "────────────────────────────────────────────────────────"].join("\n"),
    );
  };
}

/** The consult path, run in the gateway: the sandboxed agent only sees the answers. */
export async function createConsultHandler(opts: ConsultSetupOptions): Promise<ConsultHandler> {
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
  const ask = terminalConfirm(opts.prompter, opts.print);
  const confirm: ConfirmFn | undefined = opts.approval === "ask" ? ask : opts.approval === "never" ? async () => false : undefined;

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
    log: opts.log,
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
    confirmJewels: opts.approval === "never" ? async () => false : ask,
  });
  return serviceHandler(service);
}
