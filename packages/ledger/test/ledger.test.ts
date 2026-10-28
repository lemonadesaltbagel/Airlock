import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeEntry, LedgerIntegrityError, LedgerLockedError, loadOrCreateLedgerKey, openLedger, readLedger, workspaceLogDir } from "../src/index.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "airlock-ledger-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fill(path: string, key: Buffer, n = 3) {
  const l = openLedger(path, key);
  for (let i = 0; i < n; i++) l.append("egress", { host: `h${i}.example`, port: 443, decision: "denied", by: "default" });
  l.close();
}

describe("ledger", () => {
  it("round-trips entries and keeps plaintext out of the file", () => {
    const path = join(tmp(), "ledger.jsonl");
    const key = randomBytes(32);
    const l = openLedger(path, key);
    l.append("consult", { outcome: "sent", outbound: "SECRET-QUESTION-TEXT" });
    l.append("relay", { route: "local", model: "qwen", status: 200 });
    l.close();
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("SECRET-QUESTION-TEXT");
    expect(raw).not.toContain("consult");
    const entries = readLedger(path, key);
    expect(entries.map((e) => [e.seq, e.kind])).toEqual([[0, "consult"], [1, "relay"]]);
    expect(entries[0]!.data).toEqual({ outcome: "sent", outbound: "SECRET-QUESTION-TEXT" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("continues the chain across sessions", () => {
    const path = join(tmp(), "ledger.jsonl");
    const key = randomBytes(32);
    fill(path, key, 2);
    fill(path, key, 2);
    expect(readLedger(path, key).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("cannot be read with another key", () => {
    const path = join(tmp(), "ledger.jsonl");
    fill(path, randomBytes(32));
    expect(() => readLedger(path, randomBytes(32))).toThrow(LedgerIntegrityError);
  });

  it("detects an edited, removed or reordered entry", () => {
    const key = randomBytes(32);
    const base = join(tmp(), "ledger.jsonl");
    fill(base, key, 4);
    const lines = readFileSync(base, "utf8").trim().split("\n");

    const edited = JSON.parse(lines[1]!);
    edited.ct = Buffer.from("tampered").toString("base64");
    const variants = {
      edited: [lines[0], JSON.stringify(edited), lines[2], lines[3]],
      removed: [lines[0], lines[2], lines[3]],
      reordered: [lines[0], lines[2], lines[1], lines[3]],
    };
    for (const [name, v] of Object.entries(variants)) {
      const p = join(tmp(), `${name}.jsonl`);
      writeFileSync(p, v.join("\n") + "\n");
      expect(() => readLedger(p, key), name).toThrow(LedgerIntegrityError);
    }
  });

  it("refuses to append to a tampered log", () => {
    const key = randomBytes(32);
    const path = join(tmp(), "ledger.jsonl");
    fill(path, key, 2);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, [lines[1], lines[0]].join("\n") + "\n");
    expect(() => openLedger(path, key)).toThrow(LedgerIntegrityError);
  });

  it("allows one writer per workspace and recovers a stale lock", () => {
    const key = randomBytes(32);
    const path = join(tmp(), "ledger.jsonl");
    const a = openLedger(path, key);
    expect(() => openLedger(path, key)).toThrow(LedgerLockedError);
    a.close();
    writeFileSync(`${path}.lock`, "999999999");
    const b = openLedger(path, key);
    b.close();
  });

  it("keeps a file key private and stable", () => {
    const dataDir = tmp();
    const k1 = loadOrCreateLedgerKey({ dataDir, backend: "file" });
    const k2 = loadOrCreateLedgerKey({ dataDir, backend: "file" });
    expect(k1.key.equals(k2.key)).toBe(true);
    expect(statSync(join(dataDir, "log.key")).mode & 0o777).toBe(0o600);
  });

  it("puts each workspace in its own directory", () => {
    expect(workspaceLogDir("/d", "/a")).not.toBe(workspaceLogDir("/d", "/b"));
  });

  it("describes entries in one line", () => {
    const line = describeEntry({ seq: 3, timestamp: "2026-10-26T10:00:00.000Z", kind: "egress", data: { host: "registry.npmjs.org", port: 443, decision: "allowed", by: "user" } });
    expect(line).toContain("network allowed: registry.npmjs.org:443 (user)");
  });
});
