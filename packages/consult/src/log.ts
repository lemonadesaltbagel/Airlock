import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ConsultRecord } from "./types.js";

export interface ConsultLog {
  append(record: ConsultRecord): void;
}

/**
 * Plain JSONL, one record per consult attempt: an interim format until the encrypted,
 * hash-chained gateway log exists. Never place it inside a workspace.
 */
export function createJsonlConsultLog(path: string): ConsultLog {
  mkdirSync(dirname(path), { recursive: true });
  return {
    append(record) {
      appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
    },
  };
}

export function readConsultLog(path: string): ConsultRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ConsultRecord);
}

export function memoryConsultLog(): ConsultLog & { records: ConsultRecord[] } {
  const records: ConsultRecord[] = [];
  return { records, append: (r) => void records.push(r) };
}
