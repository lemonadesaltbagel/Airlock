/**
 * The agent process. `airlock run` starts it inside the OS sandbox, where the only reachable
 * address is the gateway: the agent's model calls go through the gateway's relay, and consults
 * run in the gateway. It holds no API keys; it presents the session token instead.
 */
import { attachCompletionCheck, attachStuckDetector, buildModels, createAirlockAgent, createCodingTools, getProfile } from "@airlock/agent";
import { consultTool, remoteConsultHandler } from "@airlock/consult";
import { GATEWAY_TOKEN_ENV, GATEWAY_URL_ENV, type AgentSession } from "./protocol.js";

function warn(line: string) {
  process.stderr.write(`${line}\n`);
}

async function main(): Promise<number> {
  const gatewayUrl = process.env[GATEWAY_URL_ENV];
  const token = process.env[GATEWAY_TOKEN_ENV];
  if (!gatewayUrl || !token) {
    warn("airlock agent: started without a gateway; run `airlock run` instead.");
    return 2;
  }
  // Commands the agent runs get an allowlisted environment anyway; drop the token here too.
  delete process.env[GATEWAY_TOKEN_ENV];

  const res = await fetch(`${gatewayUrl}/v1/session`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`gateway refused the session request (${res.status})`);
  const session = (await res.json()) as AgentSession;
  const profile = getProfile(session.profile);

  const consult = session.consult ? remoteConsultHandler({ gatewayUrl, token }) : undefined;
  const { agent, forceToolOnNextRequest } = createAirlockAgent({
    workspaceRoot: session.workspaceRoot,
    profile,
    role: session.role,
    models: buildModels(profile, { localApiKey: token }),
    gatewayUrl,
    tools: (ws) => [...createCodingTools(ws), ...(consult ? [consultTool(consult)] : [])],
    onBlockedRequest: (m, reason) => warn(`airlock: blocked request to ${m.provider}/${m.id}: ${reason}`),
  });
  // When the agent keeps failing its tests, tell it to consult (a local message; the consult itself
  // still goes through abstraction, the gate and the user's approval). Small local models tend to
  // ignore even a direct instruction, so the next request is made to call the consult tool.
  if (consult) attachStuckDetector(agent, { mode: "require", failedTestThreshold: 2, forceTool: forceToolOnNextRequest });
  // Before stopping, check the work against the task itself, not only the existing tests.
  attachCompletionCheck(agent, { consult: consult !== undefined });

  agent.subscribe((event) => {
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") process.stdout.write(event.assistantMessageEvent.delta);
        break;
      case "tool_execution_start":
        warn(`\n▸ ${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`);
        break;
      case "tool_execution_end":
        if (event.isError) warn(`  ✗ ${event.toolName} failed`);
        break;
    }
  });

  process.once("SIGINT", () => {
    warn("\nairlock: aborting…");
    agent.abort();
  });

  await agent.prompt(session.task);
  process.stdout.write("\n");
  const error = agent.state.errorMessage;
  if (error) {
    warn(`airlock: run ended with an error: ${error}`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    warn(`airlock agent: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  },
);
