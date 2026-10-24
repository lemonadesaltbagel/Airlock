import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COVER_SETTING_PREFIX, PUBLIC_PROFILE_FILE, randomPersona, renderProfile } from "@airlock/broker";
import { JEWELS_FILE, type JewelsConfig } from "@airlock/consult";

export const DEFAULT_PUBLIC_DESCRIPTION = "A software project. No other details about it may be revealed.";

export interface InitOptions {
  root: string;
  /** false: no cover setting. string: use this cover setting. undefined: draw one at random. */
  persona?: string | false;
  /** What may be revealed about the project. Default: nothing beyond "a software project". */
  publicDescription?: string;
  /** Replace an existing profile. */
  force?: boolean;
}

export interface InitResult {
  profilePath: string;
  jewelsPath: string;
  persona?: string;
  wroteProfile: boolean;
  wroteJewels: boolean;
}

/**
 * Creates the project's Airlock policy files. The profile and the cover setting are shown to the
 * user, who can edit or remove them; Airlock itself never derives the cover setting from the code.
 */
export function initProject(opts: InitOptions): InitResult {
  const dir = join(opts.root, ".airlock");
  mkdirSync(dir, { recursive: true });
  const profilePath = join(opts.root, PUBLIC_PROFILE_FILE);
  const jewelsPath = join(opts.root, JEWELS_FILE);

  let wroteProfile = false;
  let persona: string | undefined;
  if (!existsSync(profilePath) || opts.force) {
    persona = opts.persona === false ? undefined : (opts.persona ?? randomPersona());
    writeFileSync(profilePath, renderProfile(opts.publicDescription ?? DEFAULT_PUBLIC_DESCRIPTION, persona));
    wroteProfile = true;
  } else {
    const line = readFileSync(profilePath, "utf8").split("\n").find((l) => l.startsWith(COVER_SETTING_PREFIX));
    persona = line?.slice(COVER_SETTING_PREFIX.length).trim();
  }

  let wroteJewels = false;
  if (!existsSync(jewelsPath)) {
    const template: JewelsConfig = { terms: [], files: [], descriptions: [] };
    writeFileSync(jewelsPath, JSON.stringify(template, null, 2) + "\n");
    wroteJewels = true;
  }
  return { profilePath, jewelsPath, ...(persona ? { persona } : {}), wroteProfile, wroteJewels };
}
