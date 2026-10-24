import type { ClientIdentity } from "@earendil-works/pi-ai";

export const AIRLOCK_VERSION = "0.0.0";

/**
 * How requests identify themselves to providers: an honest, minimal User-Agent (provider
 * terms forbid misrepresenting the client) and no attribution headers. Replaces pi-ai's
 * default detailed User-Agent, which adds platform, runtime and architecture metadata.
 */
export const AIRLOCK_IDENTITY: ClientIdentity = {
  userAgent: { custom: `airlock/${AIRLOCK_VERSION}` },
  attribution: null,
};
