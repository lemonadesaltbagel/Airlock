import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createAirlockAgent } from "../src/create-agent.js";
import type { Profile } from "../src/profiles.js";
import { attachStuckDetector } from "../src/stuck.js";
import { tempDir } from "./helpers.js";

function setup() {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const profile: Profile = { name: "local", roles: { loop: { provider: "faux", model: "m" }, quality: { provider: "faux", model: "m" } }, consultant: { provider: "faux", model: "m" } };
  const { agent } = createAirlockAgent({ workspaceRoot: tempDir(), profile, models });
  return { faux, agent };
}

const failingTests = () => fauxAssistantMessage(fauxToolCall("bash", { command: "python3 -m unittest tests.test_missing -q" }), { stopReason: "toolUse" });
const nudges = (messages: unknown[]) => JSON.stringify(messages).split("[Airlock] ").length - 1;

describe("stuck detector", () => {
  it("nudges once after repeated failing test runs", async () => {
    const { faux, agent } = setup();
    faux.setResponses([failingTests(), failingTests(), failingTests(), fauxAssistantMessage("giving up")]);
    const detector = attachStuckDetector(agent, { maxTurns: 40 });
    await agent.prompt("fix it");
    expect(detector.failedTestRuns).toBe(3);
    expect(detector.nudged).toBe(true);
    expect(nudges(agent.state.messages)).toBe(1);
    expect(JSON.stringify(agent.state.messages)).toContain("The tests have failed 2 times.");
  });

  it("nudges when most of the turn budget is spent", async () => {
    const { faux, agent } = setup();
    const ls = () => fauxAssistantMessage(fauxToolCall("bash", { command: "ls" }), { stopReason: "toolUse" });
    faux.setResponses([ls(), ls(), ls(), fauxAssistantMessage("done")]);
    const detector = attachStuckDetector(agent, { maxTurns: 5 });
    await agent.prompt("explore");
    expect(detector.nudged).toBe(true);
    expect(JSON.stringify(agent.state.messages)).toContain("You have used 3 of 5 turns");
  });

  it("requires a consult in require mode, after the first failure", async () => {
    const { faux, agent } = setup();
    faux.setResponses([failingTests(), fauxAssistantMessage("ok")]);
    const detector = attachStuckDetector(agent, { maxTurns: 40, mode: "require", failedTestThreshold: 1 });
    await agent.prompt("fix it");
    expect(detector.nudged).toBe(true);
    expect(JSON.stringify(agent.state.messages)).toContain("Your next action must be one call to consult_expert");
  });

  it("stays quiet when the tests pass", async () => {
    const { faux, agent } = setup();
    const passing = () => fauxAssistantMessage(fauxToolCall("bash", { command: "python3 -m unittest -q 2>/dev/null; true" }), { stopReason: "toolUse" });
    faux.setResponses([passing(), passing(), passing(), fauxAssistantMessage("ok")]);
    const detector = attachStuckDetector(agent, { maxTurns: 40 });
    await agent.prompt("check");
    expect(detector.nudged).toBe(false);
    expect(nudges(agent.state.messages)).toBe(0);
  });
});
