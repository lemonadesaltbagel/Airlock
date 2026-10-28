import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Airlock's private data: the log and, without an OS secret store, its key. Never readable in the sandbox. */
export function airlockDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AIRLOCK_DATA_DIR) return env.AIRLOCK_DATA_DIR;
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Airlock");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "airlock");
}

export type KeyBackend = "keychain" | "secret-service" | "file";

export interface LedgerKey {
  key: Buffer;
  backend: KeyBackend;
}

const SERVICE = "Airlock log key";
const ACCOUNT = "default";

function keychainGet(): string | undefined {
  const r = spawnSync("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function keychainSet(value: string): void {
  // `security` takes the secret as an argument: briefly visible to this user's processes, never stored.
  execFileSync("/usr/bin/security", ["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", value, "-U"], { stdio: "ignore" });
}

function secretToolAvailable(): boolean {
  return spawnSync("secret-tool", ["--version"], { stdio: "ignore" }).status === 0;
}

function secretServiceGet(): string | undefined {
  const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

function secretServiceSet(value: string): void {
  // secret-tool reads the secret from stdin.
  execFileSync("secret-tool", ["store", "--label", SERVICE, "service", SERVICE, "account", ACCOUNT], { input: value, stdio: ["pipe", "ignore", "ignore"] });
}

function fileGet(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

function fileSet(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function decode(value: string): Buffer {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("stored Airlock log key is malformed");
  return key;
}

/**
 * The 256-bit key for the log, created on first use and kept in the OS secret store (macOS
 * Keychain, Linux Secret Service). Without one it falls back to a 0600 file in the data
 * directory, which protects the log only as well as file permissions do.
 */
export function loadOrCreateLedgerKey(opts: { dataDir: string; backend?: KeyBackend; env?: NodeJS.ProcessEnv }): LedgerKey {
  const forced = (opts.env ?? process.env).AIRLOCK_KEY_BACKEND;
  if (forced !== undefined && forced !== "keychain" && forced !== "secret-service" && forced !== "file") throw new Error(`AIRLOCK_KEY_BACKEND must be keychain, secret-service or file`);
  const backend: KeyBackend = opts.backend ?? forced ?? (process.platform === "darwin" ? "keychain" : secretToolAvailable() ? "secret-service" : "file");
  const filePath = join(opts.dataDir, "log.key");
  const get = backend === "keychain" ? keychainGet : backend === "secret-service" ? secretServiceGet : () => fileGet(filePath);
  const set = backend === "keychain" ? keychainSet : backend === "secret-service" ? secretServiceSet : (v: string) => fileSet(filePath, v);
  const existing = get();
  if (existing) return { key: decode(existing), backend };
  const fresh = randomBytes(32).toString("base64");
  set(fresh);
  // Read back so a store that silently failed is noticed now, not when the log is unreadable.
  const stored = get();
  if (stored !== fresh) throw new Error(`could not store the Airlock log key (${backend})`);
  return { key: decode(fresh), backend };
}
