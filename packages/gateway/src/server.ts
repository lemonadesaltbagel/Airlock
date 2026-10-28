import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HttpError, readBody } from "./http.js";
import { relayRequest, type RelayRoute } from "./relay.js";

/**
 * The gateway: the only process that holds cloud API keys. It runs outside the sandbox on
 * loopback, and the sandboxed agent reaches it (and nothing else) through the sandbox proxy.
 *
 * - `/llm/<route>/...` relays the agent's own model calls to a fixed upstream, with the real key
 *   injected and only the profile's models allowed.
 * - `POST /v1/consult` runs a consult (abstraction, gate, approval, consultant) on the trusted side.
 * - `GET /v1/session` tells the agent what to do.
 */
export interface GatewayOptions {
  /** Shared secret the agent presents. Generated when omitted. */
  token?: string;
  relays: RelayRoute[];
  consult?: (body: unknown, signal: AbortSignal) => Promise<unknown>;
  session?: unknown;
  onEvent?: (event: GatewayEvent) => void;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export type GatewayEvent =
  | { type: "relay"; route: string; model: string; status: number; requestBytes: number; responseBytes: number; durationMs: number }
  | { type: "relay-refused"; route: string; reason: string }
  | { type: "consult"; status: number; durationMs: number }
  | { type: "unauthorized"; path: string };

export interface Gateway {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export function presentedToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = req.headers["x-api-key"];
  return typeof key === "string" ? key : undefined;
}

function tokenMatches(presented: string | undefined, token: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/** Aborted when the client goes away before the response is finished. */
function clientSignal(res: ServerResponse): AbortSignal {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

export async function startGateway(opts: GatewayOptions): Promise<Gateway> {
  const token = opts.token ?? randomBytes(32).toString("base64url");
  const routes = new Map(opts.relays.map((r) => [r.id, r]));
  const emit = opts.onEvent ?? (() => {});
  const doFetch = opts.fetch ?? fetch;
  let port = 0;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Loopback only, addressed by IP: refuses DNS-rebinding requests from a browser.
    if (req.headers.host !== `127.0.0.1:${port}`) throw new HttpError(421, "unexpected Host header");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (!tokenMatches(presentedToken(req), token)) {
      emit({ type: "unauthorized", path: url.pathname });
      throw new HttpError(401, "missing or wrong gateway token");
    }

    const relay = /^\/llm\/([a-z0-9-]+)(\/.*)$/.exec(url.pathname);
    if (relay) {
      const route = routes.get(relay[1]!);
      if (!route) throw new HttpError(404, `no relay route "${relay[1]}"`);
      await relayRequest({ route, path: relay[2]!, search: url.search, req, res, fetch: doFetch, signal: clientSignal(res), emit });
      return;
    }
    if (url.pathname === "/v1/session" && req.method === "GET") {
      sendJson(res, 200, opts.session ?? {});
      return;
    }
    if (url.pathname === "/v1/consult" && req.method === "POST") {
      if (!opts.consult) throw new HttpError(404, "consults are disabled for this session");
      const started = Date.now();
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, "request body is not JSON");
      }
      try {
        const reply = await opts.consult(body, clientSignal(res));
        sendJson(res, 200, reply);
        emit({ type: "consult", status: 200, durationMs: Date.now() - started });
      } catch (err) {
        emit({ type: "consult", status: err instanceof HttpError ? err.status : 500, durationMs: Date.now() - started });
        throw err;
      }
      return;
    }
    throw new HttpError(404, "not found");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
