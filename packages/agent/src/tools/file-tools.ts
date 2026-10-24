import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Workspace } from "../workspace.js";
import { textResult } from "./result.js";

const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_READ_BYTES = 10 * 1024 * 1024;

export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

const readParams = Type.Object({
  path: Type.String({ description: "File path, relative to the workspace root." }),
  offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line to start at." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: `Max lines to return (default ${MAX_READ_LINES}).` })),
});

export function readTool(ws: Workspace): AgentTool<typeof readParams> {
  return {
    name: "read",
    label: "Read file",
    description: "Read a text file in the workspace. Returns numbered lines.",
    parameters: readParams,
    executionMode: "parallel",
    async execute(_id, { path, offset = 1, limit = MAX_READ_LINES }) {
      const abs = ws.resolveRead(path);
      const buf = await readFile(abs);
      if (buf.length > MAX_READ_BYTES) throw new Error(`file is larger than ${MAX_READ_BYTES} bytes: ${path}`);
      if (looksBinary(buf)) throw new Error(`file looks binary: ${path}`);
      const lines = buf.toString("utf8").split("\n");
      const start = offset - 1;
      const slice = lines.slice(start, start + Math.min(limit, MAX_READ_LINES));
      const body = slice
        .map((line, i) => {
          const text = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [truncated]` : line;
          return `${String(start + i + 1).padStart(6)}\t${text}`;
        })
        .join("\n");
      const more = start + slice.length < lines.length ? `\n… ${lines.length - start - slice.length} more lines` : "";
      return textResult(body + more, { path: ws.display(abs), lines: slice.length });
    },
  };
}

const writeParams = Type.Object({
  path: Type.String({ description: "File path, relative to the workspace root." }),
  content: Type.String({ description: "Full new file content." }),
});

export function writeTool(ws: Workspace): AgentTool<typeof writeParams> {
  return {
    name: "write",
    label: "Write file",
    description: "Create or overwrite a file in the workspace with the given content.",
    parameters: writeParams,
    executionMode: "sequential",
    async execute(_id, { path, content }) {
      const abs = ws.resolveWrite(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return textResult(`Wrote ${ws.display(abs)} (${content.length} chars).`, { path: ws.display(abs) });
    },
  };
}

const editParams = Type.Object({
  path: Type.String({ description: "File path, relative to the workspace root." }),
  old_string: Type.String({ description: "Exact text to replace. Must be unique unless replace_all is set." }),
  new_string: Type.String({ description: "Replacement text." }),
  replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence." })),
});

export function editTool(ws: Workspace): AgentTool<typeof editParams> {
  return {
    name: "edit",
    label: "Edit file",
    description: "Replace an exact string in a workspace file. Read the file first.",
    parameters: editParams,
    executionMode: "sequential",
    async execute(_id, { path, old_string, new_string, replace_all = false }) {
      if (old_string === new_string) throw new Error("old_string and new_string are identical");
      if (old_string === "") throw new Error("old_string must not be empty; use write to create files");
      const abs = ws.resolveWrite(path);
      const original = await readFile(abs, "utf8");
      const count = original.split(old_string).length - 1;
      if (count === 0) throw new Error(`old_string not found in ${path}`);
      if (count > 1 && !replace_all) {
        throw new Error(`old_string occurs ${count} times in ${path}; add context to make it unique or set replace_all`);
      }
      const updated = replace_all ? original.split(old_string).join(new_string) : original.replace(old_string, () => new_string);
      await writeFile(abs, updated, "utf8");
      const n = replace_all ? count : 1;
      return textResult(`Edited ${ws.display(abs)} (${n} replacement${n === 1 ? "" : "s"}).`, {
        path: ws.display(abs),
        replacements: n,
      });
    },
  };
}
