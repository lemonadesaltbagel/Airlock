import { afterEach, describe, expect, it } from "vitest";
import { startGateway, type Gateway, type GatewayEvent, type RelayRoute } from "../src/index.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function fakeUpstream(reply = "data: hello\n\n"): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(input), headers, body: Buffer.from(init?.body as Uint8Array).toString("utf8") });
    return new Response(reply, { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "a=b", "x-request-id": "r1" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

const ROUTES: RelayRoute[] = [
  { id: "deepseek", upstreamBaseUrl: "https://api.deepseek.com", api: "openai-completions", apiKey: "real-deepseek-key", allowedModels: ["deepseek-flash"] },
  { id: "anthropic", upstreamBaseUrl: "https://api.anthropic.com/", api: "anthropic-messages", apiKey: "real-anthropic-key", allowedModels: ["claude-haiku-4-5"] },
  { id: "local", upstreamBaseUrl: "http://127.0.0.1:9931/v1", api: "openai-completions", allowedModels: ["qwen"] },
];

let gw: Gateway | undefined;
afterEach(async () => {
  await gw?.close();
  gw = undefined;
});

async function start(extra: Partial<Parameters<typeof startGateway>[0]> = {}) {
  const upstream = fakeUpstream();
  const events: GatewayEvent[] = [];
  gw = await startGateway({ relays: ROUTES, fetch: upstream.fetch, onEvent: (e) => events.push(e), ...extra });
  return { gw, upstream, events };
}

function post(g: Gateway, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${g.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${g.token}`, ...headers },
    body: JSON.stringify(body),
  });
}

describe("gateway auth", () => {
  it("refuses requests without the session token", async () => {
    const { gw, upstream, events } = await start();
    const res = await fetch(`${gw.url}/llm/deepseek/chat/completions`, { method: "POST", body: JSON.stringify({ model: "deepseek-flash" }) });
    expect(res.status).toBe(401);
    expect(upstream.calls).toHaveLength(0);
    expect(events).toContainEqual({ type: "unauthorized", path: "/llm/deepseek/chat/completions" });
  });

  it("refuses a wrong token, including one sent as x-api-key", async () => {
    const { gw } = await start();
    const res = await post(gw, "/llm/deepseek/chat/completions", { model: "deepseek-flash" }, { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
    const res2 = await fetch(`${gw.url}/v1/session`, { headers: { "x-api-key": "nope" } });
    expect(res2.status).toBe(401);
  });

  it("accepts the token as x-api-key (Anthropic SDK style)", async () => {
    const { gw } = await start({ session: { task: "t" } });
    const res = await fetch(`${gw.url}/v1/session`, { headers: { "x-api-key": gw.token } });
    expect(await res.json()).toEqual({ task: "t" });
  });

  it("refuses a request addressed by another Host name (DNS rebinding)", async () => {
    const { gw } = await start();
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      const r = request(`${gw.url}/v1/session`, { headers: { host: "evil.example:80", authorization: `Bearer ${gw.token}` } }, (res) => resolve(res.statusCode ?? 0));
      r.end();
    });
    expect(status).toBe(421);
  });
});

describe("LLM relay", () => {
  it("forwards to the fixed upstream with the real key and strips the client's credentials", async () => {
    const { gw, upstream, events } = await start();
    const res = await post(gw, "/llm/deepseek/chat/completions", { model: "deepseek-flash", messages: [] }, { cookie: "c=1", "x-api-key": "attacker-key" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("data: hello\n\n");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-request-id")).toBe("r1");
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://api.deepseek.com/chat/completions");
    expect(call.headers.authorization).toBe("Bearer real-deepseek-key");
    expect(call.headers["x-api-key"]).toBeUndefined();
    expect(call.headers.cookie).toBeUndefined();
    expect(JSON.stringify(call.headers)).not.toContain(gw.token);
    expect(JSON.parse(call.body)).toEqual({ model: "deepseek-flash", messages: [] });
    expect(events.find((e) => e.type === "relay")).toMatchObject({ route: "deepseek", model: "deepseek-flash", status: 200 });
  });

  it("injects Anthropic keys as x-api-key and joins the base URL cleanly", async () => {
    const { gw, upstream } = await start();
    await post(gw, "/llm/anthropic/v1/messages", { model: "claude-haiku-4-5" }, { "anthropic-version": "2023-06-01" });
    const call = upstream.calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call.headers["x-api-key"]).toBe("real-anthropic-key");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("sends no key to a keyless local server", async () => {
    const { gw, upstream } = await start();
    await post(gw, "/llm/local/chat/completions", { model: "qwen" });
    expect(upstream.calls[0]!.url).toBe("http://127.0.0.1:9931/v1/chat/completions");
    expect(upstream.calls[0]!.headers.authorization).toBeUndefined();
  });

  it("refuses models outside the route's allowlist (e.g. the consultant)", async () => {
    const { gw, upstream, events } = await start();
    const res = await post(gw, "/llm/anthropic/v1/messages", { model: "claude-opus-5-5" });
    expect(res.status).toBe(403);
    expect(upstream.calls).toHaveLength(0);
    expect(events).toContainEqual(expect.objectContaining({ type: "relay-refused", route: "anthropic" }));
  });

  it("refuses unknown routes, other endpoints and other methods", async () => {
    const { gw, upstream } = await start();
    expect((await post(gw, "/llm/openai/chat/completions", { model: "x" })).status).toBe(404);
    expect((await post(gw, "/llm/deepseek/files", { model: "deepseek-flash" })).status).toBe(403);
    expect((await post(gw, "/llm/deepseek/chat/completions/../../files", { model: "deepseek-flash" })).status).toBe(403);
    const get = await fetch(`${gw.url}/llm/deepseek/chat/completions`, { headers: { authorization: `Bearer ${gw.token}` } });
    expect(get.status).toBe(405);
    expect(upstream.calls).toHaveLength(0);
  });

  it("refuses non-JSON bodies", async () => {
    const { gw } = await start();
    const res = await fetch(`${gw.url}/llm/deepseek/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${gw.token}` }, body: "not json" });
    expect(res.status).toBe(400);
  });
});

describe("consult endpoint", () => {
  it("passes the parsed body to the consult handler and returns its reply", async () => {
    let seen: unknown;
    const { gw, events } = await start({
      consult: async (body) => {
        seen = body;
        return { ok: true, text: "answer" };
      },
    });
    const res = await post(gw, "/v1/consult", { kind: "algorithm", problem: "p" });
    expect(await res.json()).toEqual({ ok: true, text: "answer" });
    expect(seen).toEqual({ kind: "algorithm", problem: "p" });
    expect(events).toContainEqual(expect.objectContaining({ type: "consult", status: 200 }));
  });

  it("is absent when consults are off", async () => {
    const { gw } = await start();
    expect((await post(gw, "/v1/consult", {})).status).toBe(404);
  });
});
