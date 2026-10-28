import type { LedgerEntry } from "./ledger.js";

type Data = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** One plain-language line per entry, for `airlock log`. */
export function describeEntry(entry: LedgerEntry): string {
  const d = (entry.data ?? {}) as Data;
  const time = entry.timestamp.replace("T", " ").slice(0, 19);
  const body = (() => {
    switch (entry.kind) {
      case "session-start":
        return `session started: profile ${str(d.profile)}, sandbox ${str(d.sandbox)}; task "${clip(str(d.task), 80)}"`;
      case "session-end":
        return `session ended (exit ${str(d.exitCode)}${d.violations ? `, ${str(d.violations)} sandbox denials` : ""})`;
      case "consult": {
        const packet = d.packet as Data | undefined;
        const title = packet?.title ? ` "${clip(str(packet.title), 70)}"` : "";
        const sent = typeof d.outbound === "string" ? `, ${d.outbound.length} chars` : "";
        return `consult ${str(d.outcome)}${title}${sent}${d.consultantModel ? ` → ${str(d.consultantModel)}` : ""}`;
      }
      case "relay":
        return `model call ${str(d.route)}/${str(d.model)} → ${str(d.status)} (${str(d.requestBytes)} B out, ${str(d.responseBytes)} B in)`;
      case "egress":
        return `network ${str(d.decision)}: ${str(d.host)}${d.port ? `:${str(d.port)}` : ""} (${str(d.by)})`;
      case "violation":
        return `sandbox denied: ${clip(str(d.line), 120)}`;
      case "autorun": {
        const changes = (d.changes as { path: string; change: string }[] | undefined) ?? [];
        return `agent ${changes.length === 1 ? "touched an autorun file" : `touched ${changes.length} autorun files`}: ${clip(changes.map((c) => `${c.change} ${c.path}`).join(", "), 110)}`;
      }
      case "gateway":
        return `gateway: ${clip(JSON.stringify(d), 120)}`;
    }
  })();
  return `${String(entry.seq).padStart(5)}  ${time}  ${body}`;
}
