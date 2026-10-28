import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { attachCompletionCheck, attachStuckDetector, createAirlockAgent, withForcedTool, type Profile } from "../src/index.js";
import { tempDir } from "./helpers.js";

function setup() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const profile: Profile = { name: "local", roles: { loop: { provider: "faux", model: "m" }, quality: { provider: "faux", model: "m" } }, consultant: { provider: "faux", model: "m" } };
  return { faux, ...createAirlockAgent({ workspaceRoot: tempDir(), profile, models }) };
}

const userTexts = (messages: unknown[]) =>
  (messages as { role: string; content: string | { type: string; text?: string }[] }[])
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join("")));

describe("completion check", () => {
  it("asks once, when the agent would otherwise stop, and lets it keep working", async () => {
    const { faux, agent } = setup();
    faux.setResponses([
      fauxAssistantMessage("Fixed."),
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo checking" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Verified: example reproduced, suite passes."),
    ]);
    attachCompletionCheck(agent, { consult: false });
    await agent.prompt("fix it");
    const users = userTexts(agent.state.messages);
    expect(users.filter((t) => t.includes("Before you finish"))).toHaveLength(1);
    expect(users[0]).toBe("fix it");
    expect(JSON.stringify(agent.state.messages.at(-1))).toContain("Verified");
    expect(users.join()).not.toContain("consult_expert");
  });
});

describe("forced consult", () => {
  it("adds a named tool choice in each API's shape", () => {
    expect(withForcedTool({ model: "x" }, "openai-completions", "consult_expert")).toEqual({ model: "x", tool_choice: { type: "function", function: { name: "consult_expert" } } });
    expect(withForcedTool({ model: "x" }, "anthropic-messages", "consult_expert")).toEqual({ model: "x", tool_choice: { type: "tool", name: "consult_expert" } });
    // Anthropic does not allow forcing a tool with extended thinking on.
    expect(withForcedTool({ thinking: { type: "enabled" } }, "anthropic-messages", "t")).toEqual({ thinking: { type: "enabled" } });
  });

  it("forces only the request right after the stuck detector requires a consult", async () => {
    const { faux, agent, forceToolOnNextRequest } = setup();
    const forced: unknown[] = [];
    // Each step sees the request options; record what the forced-tool hook would send.
    const observe = (reply: ReturnType<typeof fauxAssistantMessage>) => async (_ctx: unknown, options: { onPayload?: (p: unknown, m: unknown) => unknown } | undefined, _s: unknown, model: object) => {
      forced.push(options?.onPayload ? await options.onPayload({ model: "m" }, { ...model, api: "openai-completions" }) : null);
      return reply;
    };
    const failing = fauxAssistantMessage(fauxToolCall("bash", { command: "python3 -m unittest tests.test_missing -q" }), { stopReason: "toolUse" });
    faux.setResponses([observe(failing), observe(fauxAssistantMessage("after")), observe(fauxAssistantMessage("end"))] as never);
    attachStuckDetector(agent, { maxTurns: 40, mode: "require", failedTestThreshold: 1, forceTool: forceToolOnNextRequest });
    await agent.prompt("fix it");
    expect(forced).toEqual([null, { model: "m", tool_choice: { type: "function", function: { name: "consult_expert" } } }]);
  });
});
