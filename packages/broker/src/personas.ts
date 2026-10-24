import { randomInt } from "node:crypto";

/**
 * Cover settings for consult packets. Every consult from a project is framed in the same fictional
 * setting, so a history of consults points to that setting instead of to the project (RootGuard-style
 * "sanitize once"). Drawn at random, never derived from the project, so the persona itself
 * carries no information about it.
 *
 * Deliberately broad and ordinary, so most technical questions can be told in them.
 */
export const PERSONA_POOL: readonly string[] = [
  "it manages a city library's book lending, reservations and returns across several branches.",
  "it schedules charging sessions for a warehouse's fleet of autonomous forklifts across a bank of charging docks.",
  "it tracks wear on a tool-hire company's rental power tools and picks replacement kits for each job.",
  "it flags unusual readings from vibration sensors on a water utility's pumping stations.",
  "it plans flight paths for battery-powered survey drones visiting inspection points on a wind farm.",
  "it books meeting rooms and desks for a co-working space and bills members for usage.",
  "it schedules maintenance crews for a regional bus company's depots and vehicles.",
  "it allocates allotment plots to members of a community gardening society and tracks waiting lists.",
  "it manages a music school's lessons, teacher timetables and instrument loans.",
  "it runs a bicycle-sharing scheme's docking stations, rebalancing vans and rider accounts.",
  "it tracks a vineyard's barrels, tastings and bottling runs.",
  "it schedules a swimming pool's lanes, lessons and lifeguard rotas.",
  "it manages a camping site's pitches, bookings and seasonal pricing.",
  "it coordinates volunteers, shifts and donations for a food bank network.",
  "it tracks a theatre company's costumes, props and rehearsal schedules.",
  "it plans routes and loads for a furniture removal company's vans.",
  "it manages a model-railway club's layout, rolling stock and operating sessions.",
  "it schedules a print shop's jobs across its presses and finishing machines.",
  "it manages an observatory's telescope time, observing requests and image archive.",
  "it tracks a beekeeping cooperative's hives, inspections and honey harvests.",
];

export const COVER_SETTING_PREFIX = "COVER SETTING:";

export function randomPersona(): string {
  return PERSONA_POOL[randomInt(PERSONA_POOL.length)]!;
}

/**
 * Distinct random candidates for the user to choose from. A cover setting that resembles the real
 * project (e.g. "discounting licence seats" for a markdown-pricing tool) leaks the mechanism through
 * the analogy, and the user is the best judge of resemblance.
 */
export function personaCandidates(n: number): string[] {
  const pool = [...PERSONA_POOL];
  const out: string[] = [];
  while (out.length < Math.min(n, pool.length)) out.push(pool.splice(randomInt(pool.length), 1)[0]!);
  return out;
}

/** The public profile file body: what may be revealed, plus the cover setting (if any). */
export function renderProfile(publicDescription: string, persona?: string): string {
  const lines = [publicDescription.trim()];
  if (persona) lines.push("", `${COVER_SETTING_PREFIX} ${persona.trim()}`);
  return lines.join("\n") + "\n";
}
