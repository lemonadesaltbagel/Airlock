import type { ConsultPacket, ConsultRequest } from "./types.js";

/** The exact text sent to the consultant for an abstracted packet. The gate checks this string. */
export function renderPacket(packet: ConsultPacket): string {
  const parts = [`# ${packet.title}`, "", packet.question.trim()];
  if (packet.code?.trim()) parts.push("", "```" + (packet.language ?? ""), packet.code.trimEnd(), "```");
  if (packet.constraints?.length) parts.push("", "Constraints:", ...packet.constraints.map((c) => `- ${c}`));
  return parts.join("\n");
}

/**
 * The naive baseline (eval arm A1): what a developer pasting into a chat window would send —
 * the problem as written plus the raw files. Used only to measure leakage; never a product mode.
 */
export function renderNaive(request: ConsultRequest, files: { path: string; content: string }[]): string {
  const parts = [request.problem.trim()];
  if (request.attempts?.trim()) parts.push("", "What I tried:", request.attempts.trim());
  for (const f of files) parts.push("", `File: ${f.path}`, "```", f.content.trimEnd(), "```");
  return parts.join("\n");
}
