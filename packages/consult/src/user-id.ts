import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Opaque id for provider-side attribution (`metadata.user_id`): a random install id, hashed.
 * It links this user's requests to each other — which providers already can via the API key —
 * but contains nothing derived from the user, the machine or the project.
 */
export function getOrCreateUserId(path = join(homedir(), ".airlock", "install-id")): string {
  let id: string;
  if (existsSync(path)) {
    id = readFileSync(path, "utf8").trim();
  } else {
    id = randomUUID();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, id + "\n", { mode: 0o600 });
  }
  return createHash("sha256").update(`airlock-user:${id}`).digest("hex").slice(0, 32);
}
