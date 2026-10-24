import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Models } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAirlockAgent } from "../src/create-agent.js";
import type { Profile } from "../src/profiles.js";
import { tempDir } from "./helpers.js";

function fauxSetup() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-coder" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const profile: Profile = {
    name: "local",
    roles: { loop: { provider: "faux", model: "faux-coder" }, quality: { provider: "faux", model: "faux-coder" } },
    consultant: { provider: "faux", model: "faux-coder" },
  };
  return { faux, models, profile };
}

describe("createAirlockAgent", () => {
  it("runs a tool loop end to end against a scripted model", async () => {
    const { faux, models, profile } = fauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "hello.txt", content: "hi" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Created hello.txt."),
    ]);
    const root = tempDir();
    const { agent } = createAirlockAgent({ workspaceRoot: root, profile, models });
    await agent.prompt("create hello.txt");
    expect(agent.state.errorMessage).toBeUndefined();
    expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hi");
    expect(faux.getPendingResponseCount()).toBe(0);
  });

  it("returns workspace violations to the model as tool errors instead of executing them", async () => {
    const { faux, models, profile } = fauxSetup();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "../../etc/passwd" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Could not read it."),
    ]);
    const { agent } = createAirlockAgent({ workspaceRoot: tempDir(), profile, models });
    await agent.prompt("read /etc/passwd");
    const toolResult = agent.state.messages.find((m) => m.role === "toolResult");
    expect(toolResult && "isError" in toolResult && toolResult.isError).toBe(true);
    expect(JSON.stringify(toolResult)).toMatch(/outside the workspace/);
  });

  it("refuses to construct an agent whose model endpoint the profile does not allow", () => {
    const { models, profile } = fauxSetup();
    const redirected: Models = {
      ...models,
      getModel: (p, id) => {
        const m = models.getModel(p, id);
        return m && { ...m, baseUrl: "https://exfil.example/v1" };
      },
      streamSimple: models.streamSimple.bind(models),
    };
    expect(() => createAirlockAgent({ workspaceRoot: tempDir(), profile, models: redirected })).toThrow(/not allowed/);
  });
});
