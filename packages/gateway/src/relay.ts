import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { HttpError, readBody } from "./http.js";
import type { GatewayEvent } from "./server.js";

export type RelayApi = "anthropic-messages" | "openai-completions";

/**
 * One upstream the agent's own models may use. The agent picks the route by id; the upstream
 * URL, the key and the allowed models are fixed here, so the agent cannot point the relay at
 * another host, use another account's key, or call a model outside its profile (such as the
 * consultant).
 */
export interface RelayRoute {
  id: string;
  upstreamBaseUrl: string;
  api: RelayApi;
  /** Injected on every request; undefined for a keyless local server. */
  apiKey?: string;
  allowedModels: string[];
}

const ENDPOINTS: Record<RelayApi, RegExp> = {
  "anthropic-messages": /^\/v1\/messages(\/count_tokens)?$/,
  "openai-completions": /^(\/v1)?\/chat\/completions$/,
};

/** Never forwarded upstream: hop-by-hop headers and every credential the client sent. */
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "content-length",
  "accept-encoding",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
]);

const DROP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie", "trailer", "upgrade"]);

function authHeaders(route: RelayRoute): Record<string, string> {
  if (!route.apiKey) return {};
  return route.api === "anthropic-messages" ? { "x-api-key": route.apiKey } : { authorization: `Bearer ${route.apiKey}` };
}

export interface RelayRequest {
  route: RelayRoute;
  path: string;
  search: string;
  req: IncomingMessage;
  res: ServerResponse;
  fetch: typeof fetch;
  signal: AbortSignal;
  emit: (event: GatewayEvent) => void;
}

function refuse(r: RelayRequest, status: number, reason: string): never {
  r.emit({ type: "relay-refused", route: r.route.id, reason });
  throw new HttpError(status, reason);
}

export async function relayRequest(r: RelayRequest): Promise<void> {
  const { route, req, res } = r;
  if (req.method !== "POST") refuse(r, 405, `only POST is relayed`);
  if (!ENDPOINTS[route.api].test(r.path)) refuse(r, 403, `endpoint ${r.path} is not relayed for ${route.id}`);
  const body = await readBody(req);
  let model: unknown;
  try {
    model = (JSON.parse(body.toString("utf8")) as { model?: unknown }).model;
  } catch {
    refuse(r, 400, "request body is not JSON");
  }
  if (typeof model !== "string" || !route.allowedModels.includes(model)) {
    refuse(r, 403, `model ${String(model)} is not allowed on route ${route.id}`);
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  Object.assign(headers, authHeaders(route), { "accept-encoding": "identity" });

  const started = Date.now();
  const upstream = await r.fetch(`${route.upstreamBaseUrl.replace(/\/+$/, "")}${r.path}${r.search}`, {
    method: "POST",
    headers,
    body,
    signal: r.signal,
    redirect: "manual",
  });
  const outHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE_HEADERS.has(name)) outHeaders[name] = value;
  });
  res.writeHead(upstream.status, outHeaders);
  let responseBytes = 0;
  if (upstream.body) {
    const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream);
    stream.on("data", (chunk: Buffer) => (responseBytes += chunk.length));
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      res.on("close", resolve);
      stream.pipe(res);
    }).catch(() => res.destroy());
  } else {
    res.end();
  }
  r.emit({ type: "relay", route: route.id, model: model as string, status: upstream.status, requestBytes: body.length, responseBytes, durationMs: Date.now() - started });
}
