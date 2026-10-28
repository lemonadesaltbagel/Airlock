import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readLedger, loadOrCreateLedgerKey, workspaceLogDir } from "@airlock/ledger";
import { sandboxAvailability } from "@airlock/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MAIN = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const MODEL = "qwen3.6-35b-a3b";

function chunk(delta: object, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function body(req: IncomingMessage): Promise<{ model: string; messages: { role: string; content?: unknown }[] }> {
  let raw = "";
  for await (const c of req) raw += c;
  return JSON.parse(raw);
}

/**
 * Stands in for llama-server: the first turn asks for one bash command, the next turn finishes.
 * Records what reached it, to check what the gateway forwards.
 */
function fakeModelServer(command: string) {
  const seen: { auth: string | undefined; model: string; lastUser: string }[] = [];
  const toolResults: string[] = [];
  const server = createServer(async (req, res) => {
    const b = await body(req);
    const users = b.messages.filter((m) => m.role === "user");
    seen.push({ auth: req.headers.authorization, model: b.model, lastUser: JSON.stringify(users.at(-1)?.content ?? "") });
    const toolMessages = b.messages.filter((m) => m.role === "tool");
    for (const m of toolMessages) toolResults.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    const toolTurnDone = toolMessages.length > 0;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (!toolTurnDone) {
      res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ role: "assistant", content: "All done." }));
      res.write(chunk({}, "stop"));
    }
    res.end("data: [DONE]\n\n");
  });
  return { server, seen, toolResults };
}

function runCli(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const sandboxed = sandboxAvailability().ok;

describe("airlock run end to end (fake local model)", () => {
  let root: string;
  let workspace: string;
  let dataDir: string;
  let server: Server;
  let seen: { auth: string | undefined; model: string; lastUser: string }[];
  let toolResults: string[];
  let url: string;

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-e2e-")));
    workspace = join(root, "ws");
    dataDir = join(root, "data");
    mkdirSync(workspace);
    const fake = fakeModelServer(`echo from-the-agent > made-by-agent.txt; cat "$HOME/.ssh/id_rsa" "${join(dataDir, "log.key")}" 2>/dev/null; echo "key=[$AIRLOCK_GATEWAY_TOKEN]"`);
    server = fake.server;
    seen = fake.seen;
    toolResults = fake.toolResults;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });

  afterAll(() => {
    server?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it(`runs the agent ${sandboxed ? "in the OS sandbox" : "unsandboxed"} through the gateway and logs the session`, async () => {
    const r = await runCli(
      ["run", "--profile", "local", "--no-consult", ...(sandboxed ? [] : ["--unsandboxed"]), "make the file"],
      { AIRLOCK_LOCAL_URL: url, AIRLOCK_DATA_DIR: dataDir, AIRLOCK_KEY_BACKEND: "file", ANTHROPIC_API_KEY: "sk-ant-parent-only" },
      workspace,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("All done.");
    expect(readFileSync(join(workspace, "made-by-agent.txt"), "utf8").trim()).toBe("from-the-agent");
    if (sandboxed) expect(r.stderr).toContain("agent sandboxed");

    // The model server got the profile's model, and never the gateway token or the parent's keys.
    // Three calls: the tool call, the first "done", and the answer to the completion check.
    expect(seen.length).toBe(3);
    expect(seen[2]!.lastUser).toContain("Before you finish");
    expect(seen.every((s) => s.model === MODEL && s.auth === undefined)).toBe(true);

    const { key } = loadOrCreateLedgerKey({ dataDir, backend: "file" });
    const entries = readLedger(join(workspaceLogDir(dataDir, workspace), "ledger.jsonl"), key);
    const kinds = entries.map((e) => e.kind);
    expect(kinds[0]).toBe("session-start");
    expect(kinds.at(-1)).toBe("session-end");
    expect(kinds.filter((k) => k === "relay")).toHaveLength(3);
    expect(existsSync(join(dataDir, "log.key"))).toBe(true);
  }, 60_000);

  it("keeps the gateway token and Airlock's key out of the agent's commands", () => {
    // The scripted command printed $AIRLOCK_GATEWAY_TOKEN and tried to read the log key; its output
    // came back to the model as the tool result.
    const output = toolResults.join("\n");
    expect(output).toContain("key=[]");
    if (sandboxed) expect(output).not.toMatch(/[A-Za-z0-9+/]{43}=/);
  });
});
