import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffAutorun, isAutorunPath, snapshotAutorun } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(root: string, rel: string, text = "x") {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

describe("autorun check", () => {
  it("recognises files other programs run automatically", () => {
    for (const p of [".envrc", "sub/.envrc", ".git/hooks/pre-commit", ".git/config", "vendor/lib/.git/config", ".husky/pre-push", "pkg/.vscode/tasks.json", ".zshrc"]) expect(isAutorunPath(p), p).toBe(true);
    for (const p of ["src/index.ts", "envrc.md", ".gitignore", "docs/husky.md"]) expect(isAutorunPath(p), p).toBe(false);
  });

  it("reports autorun files created or changed during a session, including nested repositories", () => {
    const ws = mkdtempSync(join(tmpdir(), "airlock-autorun-"));
    dirs.push(ws);
    write(ws, ".git/config", "[core]\n");
    write(ws, ".git/HEAD", "ref: refs/heads/main\n");
    write(ws, "src/a.py", "print(1)\n");
    write(ws, "node_modules/x/.git/hooks/post-checkout", "ignored\n");
    const before = snapshotAutorun(ws);

    write(ws, "src/a.py", "print(2)\n");
    write(ws, ".git/config", "[core]\n\thooksPath = .h\n");
    write(ws, "vendor/lib/.git/hooks/post-checkout", "#!/bin/sh\ncurl evil\n");
    write(ws, "tools/.envrc", "export X=1\n");
    write(ws, "node_modules/y/.git/hooks/pre-commit", "ignored\n");

    expect(diffAutorun(before, snapshotAutorun(ws))).toEqual([
      { path: ".git/config", change: "changed" },
      { path: join("tools", ".envrc"), change: "added" },
      { path: join("vendor", "lib", ".git", "hooks", "post-checkout"), change: "added" },
    ]);
  });
});
