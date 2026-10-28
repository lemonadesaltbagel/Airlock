import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSandboxConfig, SandboxPolicyError } from "../src/index.js";

const base = { sessionTmp: "/tmp/airlock-s", runtimeRoots: ["/opt/node"], privateDirs: ["/data/airlock"], allowedHosts: ["127.0.0.1:4000"] };

describe("sandbox policy", () => {
  it("denies the home directories, re-opens the workspace and allows only the gateway", () => {
    const ws = join(homedir(), "code", "proj");
    const c = buildSandboxConfig({ ...base, workspaceRoot: ws });
    expect(c.filesystem?.denyRead).toEqual([dirname(homedir()), "/data/airlock"]);
    expect(c.filesystem?.allowRead).toEqual(expect.arrayContaining([ws, "/tmp/airlock-s", "/opt/node"]));
    expect(c.filesystem?.allowWrite).toEqual([ws, "/tmp/airlock-s"]);
    expect(c.network.allowedDomains).toEqual(["127.0.0.1:4000"]);
    expect(c.network.allowLocalBinding).toBe(false);
    expect(c.allowAppleEvents).toBe(false);
  });

  it("protects files that run later outside the sandbox, at the top level and nested", () => {
    const c = buildSandboxConfig({ ...base, workspaceRoot: "/w/p" });
    expect(c.filesystem?.denyWrite).toEqual(expect.arrayContaining(["/w/p/.git/hooks", "/w/p/.git/config", "/w/p/.airlock", "/w/p/.envrc", "/w/p/**/.git/hooks/**", "/w/p/**/.husky/**"]));
  });

  it("refuses workspaces that would re-open the home directory or Airlock's data", () => {
    expect(() => buildSandboxConfig({ ...base, workspaceRoot: homedir() })).toThrow(SandboxPolicyError);
    expect(() => buildSandboxConfig({ ...base, workspaceRoot: "/" })).toThrow(SandboxPolicyError);
    expect(() => buildSandboxConfig({ ...base, workspaceRoot: "/data/airlock/logs" })).toThrow(SandboxPolicyError);
    expect(() => buildSandboxConfig({ ...base, workspaceRoot: "/data" })).toThrow(SandboxPolicyError);
    expect(() => buildSandboxConfig({ ...base, workspaceRoot: "/w/[x]" })).toThrow(SandboxPolicyError);
  });

  it("refuses readable paths that contain Airlock's data", () => {
    expect(() => buildSandboxConfig({ ...base, workspaceRoot: "/w/p", runtimeRoots: ["/data"] })).toThrow(SandboxPolicyError);
  });
});
