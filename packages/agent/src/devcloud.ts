import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProfileName } from "./profiles.js";

/**
 * Marker a human places in a project to confirm it is synthetic or public and may be sent
 * in full to cloud models. The agent cannot create it: `.airlock/` is write-denied.
 */
export const DEV_CLOUD_MARKER = ".airlock/dev-cloud-ok";

export class ProfileNotAllowedError extends Error {
  override name = "ProfileNotAllowedError";
}

export function assertProfileAllowed(profile: ProfileName, workspaceRoot: string, opts: { devCloudFlag: boolean }): void {
  if (profile !== "dev-cloud") return;
  if (!opts.devCloudFlag) {
    throw new ProfileNotAllowedError(
      "the dev-cloud profile sends the full project to cloud models; pass --dev-cloud to confirm",
    );
  }
  if (!existsSync(join(workspaceRoot, DEV_CLOUD_MARKER))) {
    throw new ProfileNotAllowedError(
      `dev-cloud is only allowed on synthetic or public projects. If this is one, create ${DEV_CLOUD_MARKER} in it. Never do this for private code.`,
    );
  }
}
