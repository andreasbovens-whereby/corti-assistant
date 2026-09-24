import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { silentLogger, type Logger } from "../logger.js";
import type { MemorySink, MemorySinkEvent } from "../output/memory-sink.js";
import type { SessionManager } from "./session-manager.js";
import { decide, verifySignature, type WherebyWebhook } from "./webhooks.js";

export interface AppOptions {
  manager: SessionManager;
  memory: MemorySink;
  demoToken: string;
  webhookSecret: string | null;
  triggerRoomPattern: RegExp | null;
  logger?: Logger;
  /** SSE keep-alive interval; proxies such as ngrok close idle connections. */
  heartbeatMs?: number;
}

const MAX_BODY_BYTES = 256 * 1024;
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  // The demo page is opened with its token in the URL fragment; never leak URLs onward.
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

/**
 * One HTTP server for everything (see NOTES.md for why not the SDK's Trigger):
 *
 * - `POST /webhooks/whereby`: Whereby webhooks and the in-room "invite assistant" requests
 * - `GET /healthz`: liveness, for tunnels and deployments
 * - `GET /`, `/app.js`, `/style.css`: the demo page (static, contains no data)
 * - `/api/*`: session data, live updates (SSE) and start/end actions, behind the shared token
 */
export function createApp({ manager, memory, demoToken, webhookSecret, triggerRoomPattern, logger = silentLogger, heartbeatMs = 15_000 }: AppOptions): Server {
  const publicDir = findPublicDir();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /healthz") return json(res, 200, { status: "ok", sessions: manager.active.length });

    // Endpoint check: the SDK's own Trigger answers GET on its webhook path the same way.
    if (route === "GET /webhooks/whereby") return json(res, 200, { status: "ok" });

    if (route === "POST /webhooks/whereby") {
      const body = await readBody(req);
      if (webhookSecret && !verifySignature(header(req, "whereby-signature"), body, webhookSecret)) {
        logger.warn("Rejected a webhook with a missing or invalid signature");
        return json(res, 401, { error: "invalid signature" });
      }
      let webhook: WherebyWebhook;
      try {
        webhook = JSON.parse(body) as WherebyWebhook;
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      const decision = decide(webhook, triggerRoomPattern);
      // What Whereby sends, without personal data: answers "do webhooks include externalId/role?".
      logger.info("Webhook received", {
        type: webhook.type,
        roleName: webhook.data?.roleName,
        hasExternalId: Boolean(webhook.data?.externalId),
        signed: Boolean(header(req, "whereby-signature")),
        fields: Object.keys(webhook.data ?? {}),
        decision: decision.action,
        reason: decision.reason,
      });
      const result = decision.action === "start" ? manager.start(decision.roomUrl, decision.reason) : undefined;
      return json(res, 200, { decision: decision.action, reason: decision.reason, ...(result ? { result } : {}) });
    }

    const file = req.method === "GET" ? STATIC_FILES[url.pathname] : undefined;
    if (file) {
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": file.type, "cache-control": "no-cache" });
      return void res.end(readFileSync(join(publicDir, file.file)));
    }

    if (url.pathname.startsWith("/api/")) {
      if (!authorized(req, url, demoToken)) return json(res, 401, { error: "missing or wrong token" });

      if (route === "GET /api/sessions") return json(res, 200, snapshot(memory, manager));
      if (route === "GET /api/events") return streamEvents(req, res, memory, manager, heartbeatMs);
      if (route === "POST /api/sessions") {
        let roomUrl: string | undefined;
        try {
          roomUrl = (JSON.parse(await readBody(req)) as { roomUrl?: string }).roomUrl;
        } catch {
          return json(res, 400, { error: "invalid JSON" });
        }
        if (!roomUrl || !/^https:\/\/[a-z0-9-]+\.whereby\.com\/[^/?#]+/i.test(roomUrl)) {
          return json(res, 400, { error: "roomUrl must be a Whereby room URL" });
        }
        return json(res, 202, manager.start(roomUrl, "started from the demo page"));
      }
      const endMatch = req.method === "POST" ? url.pathname.match(/^\/api\/sessions\/([^/]+)\/end$/) : null;
      if (endMatch) {
        const session = manager.find(decodeURIComponent(endMatch[1]!));
        if (!session) return json(res, 404, { error: "no running session with that id" });
        void session.end("ended from the demo page");
        return json(res, 202, { status: "ending" });
      }
    }
    json(res, 404, { error: "not found" });
  };

  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error("Request failed", { path: req.url?.split("?")[0], error: String(error) });
      if (!res.headersSent) json(res, error instanceof BodyTooLargeError ? 413 : 500, { error: "request failed" });
      else res.end();
    });
  });
}

function snapshot(memory: MemorySink, manager: SessionManager) {
  const running = new Set(manager.active.map((s) => s.id));
  return memory.list().map((record) => ({ ...record, running: running.has(record.info.sessionId) }));
}

/** Server-sent events: a snapshot first, then every update as it happens. */
function streamEvents(req: IncomingMessage, res: ServerResponse, memory: MemorySink, manager: SessionManager, heartbeatMs: number): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("snapshot", snapshot(memory, manager));
  const onUpdate = (event: MemorySinkEvent) => send("update", { ...event, at: new Date().toISOString() });
  memory.on("update", onUpdate);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);
  req.on("close", () => {
    clearInterval(heartbeat);
    memory.off("update", onUpdate);
  });
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  // EventSource can't send headers, so the SSE endpoint takes the token as a query parameter.
  const given = header(req, "authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (part: Buffer) => {
      size += part.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
      } else parts.push(part);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

/** `public/` at the package root, whether running from src/ (tsx) or dist/ (compiled). */
function findPublicDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Couldn't find the package root (for public/)");
    dir = parent;
  }
  return join(dir, "public");
}
