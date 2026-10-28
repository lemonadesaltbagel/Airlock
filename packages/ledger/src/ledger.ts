import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The outbound log: every consult, relayed model call, egress decision and sandbox violation of
 * a workspace, append-only. Each entry is encrypted (AES-256-GCM) and chained to the previous one
 * with an HMAC, so reading needs the key, and editing, reordering or dropping entries is detected.
 * Dropping entries from the end is detected only against a count recorded elsewhere.
 */
export type LedgerEntryKind = "session-start" | "session-end" | "consult" | "relay" | "egress" | "violation" | "gateway" | "autorun";

export interface LedgerEntry<T = unknown> {
  seq: number;
  timestamp: string;
  kind: LedgerEntryKind;
  data: T;
}

interface StoredLine {
  v: 1;
  seq: number;
  iv: string;
  ct: string;
  tag: string;
  mac: string;
}

export interface Ledger {
  readonly path: string;
  append<T>(kind: LedgerEntryKind, data: T): LedgerEntry<T>;
  close(): void;
}

export class LedgerIntegrityError extends Error {
  override name = "LedgerIntegrityError";
  constructor(
    readonly seq: number,
    message: string,
  ) {
    super(message);
  }
}

export class LedgerLockedError extends Error {
  override name = "LedgerLockedError";
}

export function workspaceLogDir(dataDir: string, workspaceRoot: string): string {
  const id = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return join(dataDir, "logs", id);
}

function keys(master: Buffer) {
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
  return { enc: derive("airlock-ledger-enc-v1"), mac: derive("airlock-ledger-mac-v1") };
}

function lineMac(macKey: Buffer, prev: string, l: Omit<StoredLine, "mac">): string {
  return createHmac("sha256", macKey).update(`${prev}|${l.v}|${l.seq}|${l.iv}|${l.ct}|${l.tag}`).digest("base64");
}

const GENESIS = "airlock-ledger-genesis";

/** Reads and verifies every entry. Throws LedgerIntegrityError at the first bad one. */
export function readLedger(path: string, master: Buffer): LedgerEntry[] {
  if (!existsSync(path)) return [];
  const k = keys(master);
  const entries: LedgerEntry[] = [];
  let prev = GENESIS;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  lines.forEach((raw, i) => {
    let line: StoredLine;
    try {
      line = JSON.parse(raw) as StoredLine;
    } catch {
      throw new LedgerIntegrityError(i, `entry ${i} is not valid JSON`);
    }
    if (line.seq !== i) throw new LedgerIntegrityError(i, `entry ${i} has sequence number ${line.seq}`);
    const { mac, ...rest } = line;
    if (lineMac(k.mac, prev, rest) !== mac) throw new LedgerIntegrityError(i, `entry ${i} fails the chain check (edited, reordered or removed entries)`);
    let plain: string;
    try {
      const d = createDecipheriv("aes-256-gcm", k.enc, Buffer.from(line.iv, "base64"));
      d.setAAD(Buffer.from(String(line.seq)));
      d.setAuthTag(Buffer.from(line.tag, "base64"));
      plain = Buffer.concat([d.update(Buffer.from(line.ct, "base64")), d.final()]).toString("utf8");
    } catch {
      throw new LedgerIntegrityError(i, `entry ${i} cannot be decrypted`);
    }
    entries.push({ seq: line.seq, ...(JSON.parse(plain) as Omit<LedgerEntry, "seq">) });
    prev = mac;
  });
  return entries;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(lockPath: string): void {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const holder = Number(readFileSync(lockPath, "utf8").trim());
  if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
    throw new LedgerLockedError(`another Airlock session (pid ${holder}) is using this workspace's log`);
  }
  rmSync(lockPath, { force: true });
  writeFileSync(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
}

/** Opens (verifying the existing chain) for appending. One writer per workspace at a time. */
export function openLedger(path: string, master: Buffer): Ledger {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock`;
  acquireLock(lockPath);
  let fd: number;
  let seq: number;
  let prev: string;
  try {
    const existing = readLedger(path, master);
    seq = existing.length;
    const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((l) => l.trim()) : [];
    prev = lines.length ? (JSON.parse(lines[lines.length - 1]!) as StoredLine).mac : GENESIS;
    fd = openSync(path, "a", 0o600);
  } catch (err) {
    rmSync(lockPath, { force: true });
    throw err;
  }
  const k = keys(master);
  let closed = false;
  return {
    path,
    append<T>(kind: LedgerEntryKind, data: T): LedgerEntry<T> {
      if (closed) throw new Error("ledger is closed");
      const entry: LedgerEntry<T> = { seq, timestamp: new Date().toISOString(), kind, data };
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", k.enc, iv);
      c.setAAD(Buffer.from(String(seq)));
      const ct = Buffer.concat([c.update(JSON.stringify({ timestamp: entry.timestamp, kind, data }), "utf8"), c.final()]);
      const rest: Omit<StoredLine, "mac"> = { v: 1, seq, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
      const mac = lineMac(k.mac, prev, rest);
      writeSync(fd, JSON.stringify({ ...rest, mac }) + "\n");
      prev = mac;
      seq += 1;
      return entry;
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
      rmSync(lockPath, { force: true });
    },
  };
}
