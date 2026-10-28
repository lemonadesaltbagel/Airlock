import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../src/env.js";
import { bashTool, editTool, globToRegExp, grepTool, OutputCapture, readTool, truncateMiddle, writeTool } from "../src/tools/index.js";
import { createWorkspace } from "../src/workspace.js";
import { tempDir } from "./helpers.js";

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

describe("file tools", () => {
  it("reads with line numbers and offset/limit", async () => {
    const root = tempDir();
    writeFileSync(join(root, "a.txt"), "one\ntwo\nthree\nfour");
    const out = text(await readTool(createWorkspace(root)).execute("1", { path: "a.txt", offset: 2, limit: 2 }));
    expect(out).toContain("     2\ttwo");
    expect(out).toContain("     3\tthree");
    expect(out).not.toContain("one");
    expect(out).toContain("1 more lines");
  });

  it("refuses binary files", async () => {
    const root = tempDir();
    writeFileSync(join(root, "b.bin"), Buffer.from([0x50, 0x00, 0x01]));
    await expect(readTool(createWorkspace(root)).execute("1", { path: "b.bin" })).rejects.toThrow(/binary/);
  });

  it("writes new files, creating parent directories", async () => {
    const root = tempDir();
    await writeTool(createWorkspace(root)).execute("1", { path: "deep/dir/f.ts", content: "x" });
    expect(readFileSync(join(root, "deep/dir/f.ts"), "utf8")).toBe("x");
  });

  it("refuses to write the dev-cloud marker", async () => {
    const ws = createWorkspace(tempDir());
    await expect(writeTool(ws).execute("1", { path: ".airlock/dev-cloud-ok", content: "" })).rejects.toThrow(/not allowed/);
  });

  it("edits a unique match and rejects ambiguous ones", async () => {
    const root = tempDir();
    writeFileSync(join(root, "e.ts"), "a = 1\nb = 1\n");
    const tool = editTool(createWorkspace(root));
    await expect(tool.execute("1", { path: "e.ts", old_string: "= 1", new_string: "= 2" })).rejects.toThrow(/occurs 2 times/);
    await tool.execute("2", { path: "e.ts", old_string: "a = 1", new_string: "a = $& 2" });
    expect(readFileSync(join(root, "e.ts"), "utf8")).toBe("a = $& 2\nb = 1\n");
    await tool.execute("3", { path: "e.ts", old_string: "1", new_string: "9", replace_all: true });
    expect(readFileSync(join(root, "e.ts"), "utf8")).toBe("a = $& 2\nb = 9\n");
  });
});

describe("grep", () => {
  it("finds matches, honours globs and skips node_modules", async () => {
    const root = tempDir();
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "src/x.ts"), "const needle = 1;\n");
    writeFileSync(join(root, "src/y.py"), "needle = 2\n");
    writeFileSync(join(root, "node_modules/z.ts"), "needle\n");
    const tool = grepTool(createWorkspace(root));
    const out = text(await tool.execute("1", { pattern: "needle", glob: "*.ts" }));
    expect(out).toBe("src/x.ts:1: const needle = 1;");
  });

  it("converts globs", () => {
    expect(globToRegExp("*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/b.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });
});

describe("bash", () => {
  it("runs in the workspace root and reports the exit code", async () => {
    const root = tempDir();
    const r = await bashTool(createWorkspace(root)).execute("1", { command: "pwd; exit 3" });
    expect(text(r)).toContain(root);
    expect(text(r)).toContain("[exit code 3]");
    expect(r.isError).toBe(true);
  });

  it("does not leak API keys from Airlock's environment", async () => {
    const env = buildChildEnv({ PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-ant-secret", AWS_SECRET_ACCESS_KEY: "x" });
    const r = await bashTool(createWorkspace(tempDir()), env).execute("1", { command: "env" });
    expect(text(r)).not.toContain("sk-ant-secret");
    expect(text(r)).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(text(r)).toContain("DO_NOT_TRACK=1");
  });

  it("kills the whole process group on timeout", async () => {
    const r = await bashTool(createWorkspace(tempDir())).execute("1", { command: "sleep 30 & sleep 30", timeout_ms: 1000 });
    expect(text(r)).toContain("timed out after 1000 ms");
    expect(r.details.timedOut).toBe(true);
  });

  it("keeps bounded output that renders like truncating the whole text", () => {
    for (const total of [10, 50, 51, 200, 5000]) {
      const full = Array.from({ length: total }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
      const capture = new OutputCapture(50);
      for (let i = 0; i < full.length; i += 7) capture.push(full.slice(i, i + 7));
      expect(capture.text(), String(total)).toBe(truncateMiddle(full, 50));
    }
  });

  it("stops a command that prints without end, instead of running out of memory", async () => {
    const r = await bashTool(createWorkspace(tempDir())).execute("1", { command: "yes", timeout_ms: 60_000 });
    expect(r.details.outputLimited).toBe(true);
    expect(r.details.timedOut).toBe(false);
    expect(text(r)).toContain("stopped: printed more than");
    expect(text(r).length).toBeLessThan(40_000);
  }, 30_000);

  it("truncates the middle of long output", () => {
    const out = truncateMiddle("a".repeat(100) + "b".repeat(100), 50);
    expect(out.startsWith("a".repeat(25))).toBe(true);
    expect(out.endsWith("b".repeat(25))).toBe(true);
    expect(out).toContain("150 chars omitted");
  });
});
