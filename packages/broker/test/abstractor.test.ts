import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAirlockAgent, createCodingTools, createWorkspace, type Profile } from "@airlock/agent";
import { buildRepoIndex, consultTool, createConsultService, createGate, emptyJewels, memoryConsultLog, type Consultant } from "@airlock/consult";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractJsonObject } from "../src/json.js";
import { createAbstractor } from "../src/abstractor.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-broker-")));
  dirs.push(root);
  const files: Record<string, string> = {
    "fleetwise/surge.py": "LANE_SURGE_CAP = 3.75\n\ndef compute_surge_multiplier(booked_tons, lane_capacity_tons):\n    return min(LANE_SURGE_CAP, 1 + (booked_tons / lane_capacity_tons) ** 2), 'x'\n",
    ".airlock/profile.md": "A Python data-processing library.",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const packetJson = (question: string, code = "") =>
  JSON.stringify({ status: "ok", crux: "tuple vs float", removed: ["domain names"], packet: { title: "Function returns tuple", question, code, language: "python", constraints: [] } });

async function setup() {
  const root = project();
  const workspace = createWorkspace(root);
  const gate = createGate(await buildRepoIndex(workspace), emptyJewels());
  const faux = fauxProvider({ provider: "faux", models: [{ id: "quality" }, { id: "loop" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  return { root, workspace, gate, faux, models };
}

describe("extractJsonObject", () => {
  it("finds the object inside fences and prose, with braces in strings", () => {
    expect(extractJsonObject('Here:\n```json\n{"a": "x}y", "b": {"c": 1}}\n```')).toEqual({ a: "x}y", b: { c: 1 } });
    expect(() => extractJsonObject("no json")).toThrow();
  });
});

describe("abstractor", () => {
  it("feeds gate findings back and returns the clean rewrite", async () => {
    const { workspace, gate, faux, models } = await setup();
    let rewritePrompt = "";
    faux.setResponses([
      fauxAssistantMessage(packetJson("Why does compute_surge_multiplier return a tuple?")),
      (context) => {
        rewritePrompt = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage(packetJson("Why does my function return a tuple instead of a float?", "def f(a, b):\n    return min(2, a / b), 'x'"));
      },
    ]);
    const abstractor = createAbstractor({ models, model: faux.getModel("quality")!, workspace, gate });
    const result = await abstractor.abstract({ kind: "bug-diagnosis", problem: "compute_surge_multiplier returns tuple", files: ["fleetwise/surge.py"] });
    expect(result.status).toBe("ok");
    expect(result.attempts).toBe(2);
    expect(result.packet?.question).not.toMatch(/surge/);
    expect(rewritePrompt).toContain("still contains project-specific text");
    expect(rewritePrompt).toContain("compute_surge_multiplier");
  });

  it("sends the public profile and files to the abstraction model, never anything else", async () => {
    const { workspace, gate, faux, models } = await setup();
    const seen: string[] = [];
    faux.setResponses([
      (context) => {
        seen.push(JSON.stringify(context));
        return fauxAssistantMessage(packetJson("Generic question?"));
      },
    ]);
    const abstractor = createAbstractor({ models, model: faux.getModel("quality")!, workspace, gate });
    await abstractor.abstract({ kind: "algorithm", problem: "p", files: ["fleetwise/surge.py", "../outside.txt"] });
    expect(seen[0]).toContain("A Python data-processing library.");
    expect(seen[0]).toContain("LANE_SURGE_CAP");
    expect(seen[0]).not.toContain("outside.txt");
  });

  it("blocks when the model says it cannot abstract, or keeps leaking", async () => {
    const { workspace, gate, faux, models } = await setup();
    const abstractor = createAbstractor({ models, model: faux.getModel("quality")!, workspace, gate, maxRewrites: 1 });
    faux.setResponses([fauxAssistantMessage(JSON.stringify({ status: "cannot_abstract", reason: "the question is the product idea" }))]);
    expect(await abstractor.abstract({ kind: "design-tradeoff", problem: "p", files: [] })).toMatchObject({ status: "blocked", reason: "the question is the product idea" });

    faux.setResponses([fauxAssistantMessage(packetJson("about LANE_SURGE_CAP")), fauxAssistantMessage(packetJson("still LANE_SURGE_CAP"))]);
    const leaky = await abstractor.abstract({ kind: "bug-diagnosis", problem: "p", files: [] });
    expect(leaky.status).toBe("blocked");
    expect(leaky.findings.map((f) => f.match)).toContain("LANE_SURGE_CAP");
  });

  it("asks again after malformed JSON", async () => {
    const { workspace, gate, faux, models } = await setup();
    faux.setResponses([fauxAssistantMessage("sure! {not json"), fauxAssistantMessage(packetJson("A generic question?"))]);
    const result = await createAbstractor({ models, model: faux.getModel("quality")!, workspace, gate }).abstract({ kind: "algorithm", problem: "p", files: [] });
    expect(result).toMatchObject({ status: "ok", attempts: 2 });
  });
});

describe("agent with consult_expert", () => {
  it("routes a consult through abstraction and returns the untrusted answer to the agent", async () => {
    const { root, workspace, gate, faux, models } = await setup();
    const consultant: Consultant = { model: faux.getModel("quality")!, ask: vi.fn(async () => ({ status: "answered" as const, text: "Return only the number.", model: "fake" })) };
    const log = memoryConsultLog();
    const service = createConsultService({
      mode: "abstracted",
      workspace,
      gate,
      consultant,
      log,
      abstractor: createAbstractor({ models, model: faux.getModel("quality")!, workspace, gate }),
    });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("consult_expert", { kind: "bug-diagnosis", problem: "compute_surge_multiplier returns a tuple", files: ["fleetwise/surge.py"] }), { stopReason: "toolUse" }),
      fauxAssistantMessage(packetJson("Why does my function return a tuple instead of a float?")), // abstraction call
      fauxAssistantMessage("Fixed by returning only the number."),
    ]);
    const profile: Profile = {
      name: "local",
      roles: { loop: { provider: "faux", model: "loop" }, quality: { provider: "faux", model: "quality" } },
      consultant: { provider: "faux", model: "quality" },
    };
    const { agent } = createAirlockAgent({ workspaceRoot: root, profile, models, tools: (ws) => [...createCodingTools(ws), consultTool(service)] });
    await agent.prompt("fix the surge bug");
    expect(agent.state.errorMessage).toBeUndefined();
    expect(log.records).toHaveLength(1);
    expect(log.records[0]!.outbound).not.toMatch(/surge|fleetwise/i);
    const toolResult = JSON.stringify(agent.state.messages.find((m) => m.role === "toolResult"));
    expect(toolResult).toContain("consultant_answer");
    expect(toolResult).toContain("Return only the number.");
  });
});

describe("cover setting", () => {
  it("is part of the default abstraction prompt, with a safety exception", async () => {
    const { ABSTRACTION_SYSTEM_PROMPT } = await import("../src/prompts.js");
    expect(ABSTRACTION_SYSTEM_PROMPT).toContain('contains a "COVER SETTING"');
    expect(ABSTRACTION_SYSTEM_PROMPT).toMatch(/security exploitation, malware, weapons, biological or chemical agents/);
    expect(ABSTRACTION_SYSTEM_PROMPT).toContain("The technical problem must stay exactly the same");
  });

  it("renders profiles and draws personas from the neutral pool", async () => {
    const { PERSONA_POOL, randomPersona, renderProfile } = await import("../src/personas.js");
    expect(PERSONA_POOL.length).toBeGreaterThanOrEqual(20);
    expect(PERSONA_POOL).toContain(randomPersona());
    expect(renderProfile("A CLI tool.", "it tracks kites.")).toBe("A CLI tool.\n\nCOVER SETTING: it tracks kites.\n");
    expect(renderProfile("A CLI tool.")).toBe("A CLI tool.\n");
  });

  it("offers distinct candidates from the pool for the user to choose", async () => {
    const { PERSONA_POOL, personaCandidates } = await import("../src/personas.js");
    const c = personaCandidates(3);
    expect(c).toHaveLength(3);
    expect(new Set(c).size).toBe(3);
    for (const p of c) expect(PERSONA_POOL).toContain(p);
  });
});
