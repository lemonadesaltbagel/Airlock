import { createWorkspace } from "@airlock/agent";
import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createConsultant, type Consultant, type ConsultantAnswer } from "../src/consultant.js";
import { createGate } from "../src/gate.js";
import { emptyJewels } from "../src/jewels.js";
import { memoryConsultLog } from "../src/log.js";
import { buildRepoIndex } from "../src/repo-index.js";
import { createConsultService, type Abstractor } from "../src/service.js";
import type { ConsultRequest } from "../src/types.js";
import { makeProject, NEUTRAL_MRE } from "./fixtures.js";

const REQUEST: ConsultRequest = {
  kind: "bug-diagnosis",
  problem: "FleetwiseSurgeEngine.compute_surge_multiplier returns a tuple for Acme lanes",
  files: ["fleetwise/surge.py"],
};

function fakeConsultant(answers: Partial<ConsultantAnswer>[]): Consultant & { ask: ReturnType<typeof vi.fn> } {
  const ask = vi.fn(async () => ({ status: "answered" as const, text: "Drop the second tuple element.", model: "fake/consultant", ...answers.shift() }));
  return { model: {} as Model<never>, ask };
}

async function setup(opts: { abstractor?: Abstractor; answers?: Partial<ConsultantAnswer>[]; budget?: number; mode?: "naive" | "abstracted" } = {}) {
  const root = makeProject();
  const workspace = createWorkspace(root);
  const gate = createGate(await buildRepoIndex(workspace), emptyJewels());
  const log = memoryConsultLog();
  const consultant = fakeConsultant(opts.answers ?? []);
  const service = createConsultService({
    mode: opts.mode ?? "abstracted",
    workspace,
    gate,
    consultant,
    log,
    ...(opts.abstractor ? { abstractor: opts.abstractor } : {}),
    ...(opts.budget ? { budget: opts.budget } : {}),
  });
  return { service, log, consultant };
}

const cleanAbstractor: Abstractor = {
  abstract: async (req) => ({
    status: "ok",
    packet: { kind: req.kind, title: "Capped quadratic multiplier returns wrong type", question: "My function should return a float but returns a tuple." },
    findings: [],
    attempts: 1,
    usage: [],
  }),
};

describe("consult service", () => {
  it("naive mode sends raw files and records what leaked", async () => {
    const { service, log, consultant } = await setup({ mode: "naive" });
    const result = await service.handle(REQUEST);
    expect(result.ok).toBe(true);
    expect(consultant.ask).toHaveBeenCalledOnce();
    expect(log.records[0]!.outbound).toContain("LANE_SURGE_CAP");
    expect(log.records[0]!.findings.map((f) => f.rule)).toEqual(expect.arrayContaining(["identifier", "literal", "jewel-term"]));
  });

  it("abstracted mode sends only the packet and wraps the answer as untrusted", async () => {
    const { service, log, consultant } = await setup({ abstractor: cleanAbstractor });
    const result = await service.handle(REQUEST);
    expect(result.ok).toBe(true);
    const sent = consultant.ask.mock.calls[0]![0] as string;
    expect(sent).not.toMatch(/fleetwise|acme|surge/i);
    expect(result.text).toContain('<consultant_answer trust="untrusted">');
    expect(result.text).toContain(sent);
    expect(log.records[0]!.outcome).toBe("sent");
  });

  it("re-checks the final packet and blocks it if the abstractor let project text through", async () => {
    const leaky: Abstractor = {
      abstract: async (req) => ({ status: "ok", packet: { kind: req.kind, title: "Help", question: "Why does compute_surge_multiplier fail?" }, findings: [], attempts: 1, usage: [] }),
    };
    const { service, consultant, log } = await setup({ abstractor: leaky });
    const result = await service.handle(REQUEST);
    expect(result.ok).toBe(false);
    expect(consultant.ask).not.toHaveBeenCalled();
    expect(log.records[0]!.outcome).toBe("blocked");
  });

  it("does not send when the abstractor blocks", async () => {
    const blocking: Abstractor = { abstract: async () => ({ status: "blocked", findings: [], attempts: 3, reason: "reveals purpose", usage: [] }) };
    const { service, consultant } = await setup({ abstractor: blocking });
    const result = await service.handle(REQUEST);
    expect(result.text).toMatch(/not sent.*reveals purpose/);
    expect(consultant.ask).not.toHaveBeenCalled();
  });

  it("treats a refusal as terminal for the session", async () => {
    const { service, consultant, log } = await setup({ abstractor: cleanAbstractor, answers: [{ status: "refused", text: "", errorMessage: "declined" }] });
    const first = await service.handle(REQUEST);
    expect(first.text).toMatch(/Do not rephrase/);
    const second = await service.handle({ ...REQUEST, problem: "rephrased" });
    expect(second.ok).toBe(false);
    expect(consultant.ask).toHaveBeenCalledOnce();
    expect(log.records.map((r) => r.outcome)).toEqual(["refused", "budget-exhausted"]);
  });

  it("enforces the per-session budget", async () => {
    const { service, consultant } = await setup({ abstractor: cleanAbstractor, budget: 1 });
    await service.handle(REQUEST);
    const second = await service.handle(REQUEST);
    expect(second.text).toMatch(/budget/);
    expect(consultant.ask).toHaveBeenCalledOnce();
  });

  it("keeps crown-jewel consults local under jewelPolicy block, and asks for them under confirm", async () => {
    const root = makeProject();
    const workspace = createWorkspace(root);
    const gate = createGate(await buildRepoIndex(workspace), emptyJewels());
    const jewelFiles = new Set(["fleetwise/surge.py"]);

    const blocking = fakeConsultant([]);
    const blocked = createConsultService({ mode: "abstracted", workspace, gate, consultant: blocking, log: memoryConsultLog(), abstractor: cleanAbstractor, jewelFiles, jewelPolicy: "block" });
    const r1 = await blocked.handle(REQUEST);
    expect(r1.record).toMatchObject({ outcome: "blocked", touchesJewels: true });
    expect(blocking.ask).not.toHaveBeenCalled();
    expect((await blocked.handle({ ...REQUEST, files: ["README.md"] })).record.outcome).toBe("sent");

    const asked: boolean[] = [];
    const confirming = fakeConsultant([]);
    const confirmed = createConsultService({
      mode: "abstracted",
      workspace,
      gate,
      consultant: confirming,
      log: memoryConsultLog(),
      abstractor: cleanAbstractor,
      jewelFiles,
      jewelPolicy: "confirm",
      confirmJewels: async (_out, record) => {
        asked.push(record.touchesJewels === true);
        return false;
      },
    });
    expect((await confirmed.handle(REQUEST)).record.outcome).toBe("declined");
    expect((await confirmed.handle({ ...REQUEST, files: [] })).record.outcome).toBe("sent");
    expect(asked).toEqual([true]);
    expect(confirming.ask).toHaveBeenCalledOnce();
  });

  it("lets the user decline before anything is sent", async () => {
    const root = makeProject();
    const workspace = createWorkspace(root);
    const consultant = fakeConsultant([]);
    const service = createConsultService({
      mode: "abstracted",
      workspace,
      gate: createGate(await buildRepoIndex(workspace), emptyJewels()),
      consultant,
      log: memoryConsultLog(),
      abstractor: cleanAbstractor,
      confirm: async () => false,
    });
    const result = await service.handle(REQUEST);
    expect(result.record.outcome).toBe("declined");
    expect(consultant.ask).not.toHaveBeenCalled();
  });
});

describe("consultant", () => {
  const message = (over: Partial<AssistantMessage>): AssistantMessage =>
    ({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-opus-5-5",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
      ...over,
    }) as AssistantMessage;
  const model = { provider: "anthropic", id: "claude-opus-5-5", reasoning: true } as unknown as Model<"anthropic-messages">;

  it("maps a provider refusal to status refused and passes the user id", async () => {
    const completeSimple = vi.fn(async (..._args: unknown[]) => message({ stopReason: "error", rawStopReason: "refusal", errorMessage: "cyber" }));
    const consultant = createConsultant({ models: { completeSimple } as unknown as Models, model, userId: "u123" });
    const answer = await consultant.ask(NEUTRAL_MRE);
    expect(answer.status).toBe("refused");
    expect(completeSimple.mock.calls[0]![2]).toMatchObject({ metadata: { user_id: "u123" } });
  });

  it("returns answers and errors", async () => {
    const ok = createConsultant({ models: { completeSimple: async () => message({}) } as unknown as Models, model });
    expect(await ok.ask("q")).toMatchObject({ status: "answered", text: "answer" });
    const failing = createConsultant({ models: { completeSimple: async () => message({ stopReason: "error", errorMessage: "529" }) } as unknown as Models, model });
    expect(await failing.ask("q")).toMatchObject({ status: "error", errorMessage: "529" });
  });
});
