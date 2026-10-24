import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { assertProfileAllowed, ProfileNotAllowedError } from "../src/devcloud.js";
import { checkEndpoint, egressRuleFor, guardStreamFn } from "../src/guard.js";
import { buildModels, localServerProvider } from "../src/models.js";
import { PROFILES } from "../src/profiles.js";
import { tempDir } from "./helpers.js";

describe("checkEndpoint", () => {
  const rule = { allowedOrigins: ["https://api.anthropic.com"] };

  it("always allows loopback", () => {
    for (const url of ["http://127.0.0.1:9931/v1", "http://localhost:8080", "http://[::1]:1234", "http://127.5.0.1"]) {
      expect(checkEndpoint(url, { allowedOrigins: [] }), url).toEqual({ ok: true });
    }
  });

  it("allows only listed https origins", () => {
    expect(checkEndpoint("https://api.anthropic.com", rule).ok).toBe(true);
    expect(checkEndpoint("https://api.anthropic.com.evil.example", rule).ok).toBe(false);
    expect(checkEndpoint("https://api.openai.com/v1", rule).ok).toBe(false);
    expect(checkEndpoint("http://api.anthropic.com", rule).ok).toBe(false);
    expect(checkEndpoint("file:///etc/passwd", rule).ok).toBe(false);
    expect(checkEndpoint("not a url", rule).ok).toBe(false);
  });
});

describe("egress rules per profile", () => {
  it("local profile allows no remote origins", () => {
    const models = buildModels(PROFILES.local);
    expect(egressRuleFor(PROFILES.local, models)).toEqual({ allowedOrigins: [] });
  });

  it("dev-cloud profile allows exactly the role models' origin", () => {
    const models = buildModels(PROFILES["dev-cloud"]);
    expect(egressRuleFor(PROFILES["dev-cloud"], models)).toEqual({ allowedOrigins: ["https://api.anthropic.com"] });
  });

  it("local profile does not even register the cloud provider", () => {
    const models = buildModels(PROFILES.local);
    expect(models.getProvider("anthropic")).toBeUndefined();
  });

  it("refuses a non-loopback local server", () => {
    expect(() => localServerProvider({ baseUrl: "http://192.168.1.5:9931/v1", models: [] })).toThrow(/loopback/);
  });
});

describe("guardStreamFn", () => {
  it("never calls the inner stream for a blocked endpoint, and fails the stream instead", async () => {
    const inner = vi.fn<StreamFn>();
    const onBlocked = vi.fn();
    const guarded = guardStreamFn(inner, { allowedOrigins: [] }, onBlocked);
    const model = buildModels(PROFILES["dev-cloud"]).getModel("anthropic", "claude-haiku-4-5")!;
    const stream = await guarded(model, { messages: [] } as never);
    const result = await stream.result();
    expect(inner).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toMatch(/blocked LLM request/);
  });
});

describe("dev-cloud gate", () => {
  it("allows the local profile unconditionally", () => {
    expect(() => assertProfileAllowed("local", tempDir(), { devCloudFlag: false })).not.toThrow();
  });

  it("requires both the flag and the marker", () => {
    const root = tempDir();
    expect(() => assertProfileAllowed("dev-cloud", root, { devCloudFlag: false })).toThrow(ProfileNotAllowedError);
    expect(() => assertProfileAllowed("dev-cloud", root, { devCloudFlag: true })).toThrow(/dev-cloud-ok/);
    mkdirSync(join(root, ".airlock"));
    writeFileSync(join(root, ".airlock/dev-cloud-ok"), "");
    expect(() => assertProfileAllowed("dev-cloud", root, { devCloudFlag: false })).toThrow(ProfileNotAllowedError);
    expect(() => assertProfileAllowed("dev-cloud", root, { devCloudFlag: true })).not.toThrow();
  });
});
