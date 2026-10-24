import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspace, WorkspaceError } from "../src/workspace.js";
import { tempDir } from "./helpers.js";

describe("workspace confinement", () => {
  it("resolves relative paths inside the root", () => {
    const root = tempDir();
    const ws = createWorkspace(root);
    expect(ws.resolveRead("src/a.ts")).toBe(join(root, "src/a.ts"));
    expect(ws.display(join(root, "src/a.ts"))).toBe("src/a.ts");
  });

  it("rejects .. escapes and absolute paths outside the root", () => {
    const ws = createWorkspace(tempDir());
    expect(() => ws.resolveRead("../outside.txt")).toThrow(WorkspaceError);
    expect(() => ws.resolveRead("src/../../outside.txt")).toThrow(WorkspaceError);
    expect(() => ws.resolveRead("/etc/passwd")).toThrow(WorkspaceError);
  });

  it("rejects a sibling directory that shares the root's name prefix", () => {
    const parent = tempDir();
    mkdirSync(join(parent, "proj"));
    mkdirSync(join(parent, "proj-secrets"));
    const ws = createWorkspace(join(parent, "proj"));
    expect(() => ws.resolveRead(join(parent, "proj-secrets/key"))).toThrow(WorkspaceError);
  });

  it("rejects symlinks pointing outside, for existing and not-yet-existing targets", () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "s3cret");
    symlinkSync(outside, join(root, "link"));
    const ws = createWorkspace(root);
    expect(() => ws.resolveRead("link/secret.txt")).toThrow(WorkspaceError);
    expect(() => ws.resolveWrite("link/new-file.txt")).toThrow(WorkspaceError);
  });

  it("allows reading but not writing policy and git-hook paths", () => {
    const root = tempDir();
    const ws = createWorkspace(root);
    expect(ws.resolveRead(".airlock/jewels.yaml")).toBe(join(root, ".airlock/jewels.yaml"));
    for (const p of [".airlock/dev-cloud-ok", ".airlock", ".git/hooks/pre-commit", ".git/config", ".Airlock/dev-cloud-ok"]) {
      expect(() => ws.resolveWrite(p), p).toThrow(/not allowed/);
    }
    expect(ws.resolveWrite(".git-notes.md")).toBe(join(root, ".git-notes.md"));
    expect(ws.resolveWrite(".airlockrc")).toBe(join(root, ".airlockrc"));
  });
});
