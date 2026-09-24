import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { CortiEnvironmentUrls } from "@corti/sdk";
import { WebSocketServer, type WebSocket } from "ws";

const TENANT = "test-tenant";
const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";

export const fakeCortiCredentials = { tenant: TENANT, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

export interface FakeCortiOptions {
  /** Reply to the stream config with this instead of CONFIG_ACCEPTED. */
  rejectConfig?: "CONFIG_DENIED" | "CONFIG_MISSING";
  /** Never answer the stream config. */
  ignoreConfig?: boolean;
  /** `expires_in` of issued tokens, in seconds. The SDK treats a token as expired 120 s early. */
  tokenExpiresInSeconds?: number;
  /** Server-side token lifetime: the stream handshake rejects older tokens with 401. */
  tokenLifetimeMs?: number;
  /** Delay between receiving `end` and sending ENDED. */
  endDelayMs?: number;
  /** Never answer `end`. */
  ignoreEnd?: boolean;
  /** Fail document generation with this HTTP status. */
  failDocuments?: number;
}

export interface Interaction {
  id: string;
  encounter: Record<string, unknown>;
  statusHistory: string[];
  documentRequests: Record<string, unknown>[];
}

export interface StreamConnection {
  interactionId: string;
  token: string;
  config: Record<string, unknown> | undefined;
  /** Binary messages, with their arrival time. */
  chunks: { data: Buffer; at: number }[];
  /** Protocol violations, e.g. audio before the config was accepted. */
  violations: string[];
  endReceived: boolean;
  closed: boolean;
  send(message: Record<string, unknown>): void;
  /** Drops the connection without a close handshake (like a network failure). */
  drop(): void;
  socket: WebSocket;
}

/**
 * A local stand-in for Corti's API, close enough for the real `@corti/sdk` to run
 * against it: OAuth token endpoint, interactions, documents, and the stream WebSocket.
 */
export class FakeCorti {
  options: FakeCortiOptions;
  readonly interactions = new Map<string, Interaction>();
  readonly streams: StreamConnection[] = [];
  readonly rejectedHandshakes: string[] = [];
  tokensIssued = 0;
  /** Called for every audio chunk; use it to script transcript and facts messages. */
  onChunk: ((connection: StreamConnection, chunkIndex: number) => void) | undefined;
  /** Extra messages to send between receiving `end` and ENDED (final facts, usage). */
  onEnd: ((connection: StreamConnection) => void) | undefined;

  private readonly server: Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly tokens = new Map<string, number>();
  private readonly sockets = new Set<Socket>();

  private constructor(options: FakeCortiOptions) {
    this.options = options;
    this.server = createServer((req, res) => void this.handleHttp(req, res));
    this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket as Socket, head));
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  static async start(options: FakeCortiOptions = {}): Promise<FakeCorti> {
    const fake = new FakeCorti(options);
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  get urls(): CortiEnvironmentUrls {
    const { port } = this.server.address() as AddressInfo;
    return {
      base: `http://127.0.0.1:${port}/v2`,
      wss: `ws://127.0.0.1:${port}/audio-bridge/v2`,
      login: `http://127.0.0.1:${port}/realms`,
      agents: `http://127.0.0.1:${port}`,
    };
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = await readBody(req);
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "POST" && url.pathname === `/realms/${TENANT}/protocol/openid-connect/token`) {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") !== "client_credentials" || form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
        return json(401, { error: "invalid_client" });
      }
      const token = `token-${++this.tokensIssued}`;
      this.tokens.set(token, Date.now());
      return json(200, { access_token: token, expires_in: this.options.tokenExpiresInSeconds ?? 3600, token_type: "Bearer" });
    }

    if (!this.isAuthorized(req.headers.authorization, req.headers["tenant-name"])) return json(401, { detail: "unauthorized" });

    let match: RegExpMatchArray | null;
    if (req.method === "POST" && url.pathname === "/v2/interactions/") {
      const request = JSON.parse(body);
      const id = randomUUID();
      this.interactions.set(id, { id, encounter: request.encounter, statusHistory: [request.encounter.status], documentRequests: [] });
      return json(201, { interactionId: id, websocketUrl: `${this.urls.wss}/interactions/${id}/streams` });
    }
    if (req.method === "PATCH" && (match = url.pathname.match(/^\/v2\/interactions\/([^/]+)$/))) {
      const interaction = this.interactions.get(match[1]!);
      if (!interaction) return json(404, { detail: "not found" });
      const request = JSON.parse(body);
      if (request.encounter?.status) interaction.statusHistory.push(request.encounter.status);
      Object.assign(interaction.encounter, request.encounter);
      return json(200, { id: interaction.id, encounter: interaction.encounter });
    }
    if (req.method === "POST" && (match = url.pathname.match(/^\/v2\/interactions\/([^/]+)\/documents\/$/))) {
      const interaction = this.interactions.get(match[1]!);
      if (!interaction) return json(404, { detail: "not found" });
      const request = JSON.parse(body);
      interaction.documentRequests.push(request);
      if (this.options.failDocuments) return json(this.options.failDocuments, { detail: "document generation failed" });
      const now = new Date().toISOString();
      const input = JSON.stringify(request.context);
      return json(200, {
        id: randomUUID(),
        name: request.name ?? "Document",
        templateRef: request.templateKey,
        isStream: false,
        outputLanguage: request.outputLanguage,
        createdAt: now,
        updatedAt: now,
        usageInfo: { creditsConsumed: 1 },
        // Sections deliberately out of order: the client must sort them.
        sections: [
          { key: "plan", name: "Plan", text: "Follow up in two weeks.", sort: 3, createdAt: now, updatedAt: now },
          { key: "subjective", name: "Subjective", text: `Based on: ${input}`, sort: 0, createdAt: now, updatedAt: now },
        ],
      });
    }
    json(404, { detail: `no fake for ${req.method} ${url.pathname}` });
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/audio-bridge\/v2\/interactions\/([^/]+)\/streams$/);
    const token = url.searchParams.get("token") ?? "";
    const reject = (status: string) => {
      this.rejectedHandshakes.push(status);
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    if (!match || !this.interactions.has(match[1]!)) return reject("404 Not Found");
    if (url.searchParams.get("tenant-name") !== TENANT || !this.isAuthorized(token)) return reject("401 Unauthorized");

    this.wss.handleUpgrade(req, socket, head, (ws) => this.handleStream(ws, match[1]!, token));
  }

  private handleStream(ws: WebSocket, interactionId: string, token: string): void {
    const connection: StreamConnection = {
      interactionId,
      token,
      config: undefined,
      chunks: [],
      violations: [],
      endReceived: false,
      closed: false,
      socket: ws,
      send: (message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message)),
      drop: () => ws.terminate(),
    };
    this.streams.push(connection);
    let accepted = false;

    ws.on("close", () => (connection.closed = true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        if (!accepted) connection.violations.push("audio before CONFIG_ACCEPTED");
        if (connection.endReceived) connection.violations.push("audio after end");
        connection.chunks.push({ data: Buffer.from(data as Buffer), at: Date.now() });
        this.onChunk?.(connection, connection.chunks.length - 1);
        return;
      }
      const message = JSON.parse(String(data));
      if (message.type === "config") {
        if (accepted) return connection.send({ type: "CONFIG_ALREADY_RECEIVED" });
        connection.config = message.configuration;
        if (this.options.ignoreConfig) return;
        if (this.options.rejectConfig) {
          connection.send({ type: this.options.rejectConfig, reason: "rejected by test" });
          return ws.close(1000);
        }
        const problem = validateConfig(message.configuration);
        if (problem) {
          connection.send({ type: "CONFIG_DENIED", reason: problem });
          return ws.close(1000);
        }
        accepted = true;
        return connection.send({ type: "CONFIG_ACCEPTED", configuration: message.configuration });
      }
      if (message.type === "end") {
        connection.endReceived = true;
        if (this.options.ignoreEnd) return;
        setTimeout(() => {
          this.onEnd?.(connection);
          connection.send({ type: "usage", credits: 0.5 });
          connection.send({ type: "ENDED" });
          ws.close(1000);
        }, this.options.endDelayMs ?? 50);
        return;
      }
      connection.violations.push(`unexpected message type ${message.type}`);
    });
  }

  private isAuthorized(authorization: string | string[] | undefined, tenant?: string | string[]): boolean {
    if (tenant !== undefined && tenant !== TENANT) return false;
    const token = typeof authorization === "string" ? authorization.replace(/^Bearer /, "") : "";
    const issuedAt = this.tokens.get(token);
    if (issuedAt === undefined) return false;
    return this.options.tokenLifetimeMs === undefined || Date.now() - issuedAt < this.options.tokenLifetimeMs;
  }
}

/** Checks the parts of the config this project relies on, like Corti would. */
function validateConfig(config: Record<string, any>): string | undefined {
  const channels = Number(/channels=(\d+)/.exec(config.audioFormat ?? "")?.[1]);
  const participants = config.transcription?.participants ?? [];
  if (config.audioFormat !== `audio/pcm; rate=16000; channels=${channels}; bits=16; endian=little; encoding=sint`) return "unsupported audioFormat";
  if (participants.length !== channels) return "participants don't match the channel count";
  if (channels > 1 && config.transcription?.isMultichannel !== true) return "isMultichannel must be true";
  if (config.mode?.type !== "facts") return "expected facts mode";
  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}
