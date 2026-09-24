import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemorySink } from "../../src/output/memory-sink.js";
import { createApp } from "../../src/server/app.js";
import { SessionManager } from "../../src/server/session-manager.js";
import type { Session } from "../../src/session/session.js";

const TOKEN = "demo-token-0123456789";
const SECRET = "whsec-test";

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? (server.closeAllConnections(), server.close(() => resolve())) : resolve())));

async function setup({ webhookSecret = SECRET as string | null, pattern = /^\/visit-/ as RegExp | null } = {}) {
  const started: string[] = [];
  const memory = new MemorySink();
  const manager = new SessionManager({
    maxSessions: 4,
    createSession: (roomUrl) => {
      started.push(roomUrl);
      const session = { id: `s-${started.length}`, roomUrl, start: async () => {}, end: async () => {}, finished: new Promise(() => {}) };
      return session as unknown as Session;
    },
  });
  server = createApp({ manager, memory, demoToken: TOKEN, webhookSecret, triggerRoomPattern: pattern, heartbeatMs: 50 });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, memory, manager, started };
}

const webhook = (type: string, roomName: string, roleName = "visitor") =>
  JSON.stringify({ type, apiVersion: "1.0", id: "evt", createdAt: "", data: { roomName, subdomain: "acme", roleName, participantId: "p", externalId: "patient:7", displayName: "Pat" } });
const signature = (body: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
};
const auth = { authorization: `Bearer ${TOKEN}` };

describe("HTTP app", () => {
  it("answers the health check", async () => {
    const { base } = await setup();
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: "ok", sessions: 0 });
    expect((await fetch(`${base}/webhooks/whereby`)).status).toBe(200);
  });

  it("starts a session from a signed webhook, once per room", async () => {
    const { base, started } = await setup();
    const body = webhook("room.client.joined", "/visit-42");
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${base}/webhooks/whereby`, { method: "POST", headers: { "whereby-signature": signature(body) }, body });
      expect(response.status).toBe(200);
    }
    expect(started).toEqual(["https://acme.whereby.com/visit-42"]);
  });

  it("rejects unsigned or forged webhooks when a secret is configured", async () => {
    const { base, started } = await setup();
    const body = webhook("assistant.requested", "/visit-42");
    expect((await fetch(`${base}/webhooks/whereby`, { method: "POST", body })).status).toBe(401);
    const forged = { "whereby-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` };
    expect((await fetch(`${base}/webhooks/whereby`, { method: "POST", headers: forged, body })).status).toBe(401);
    expect(started).toEqual([]);
  });

  it("accepts unsigned webhooks when no secret is configured", async () => {
    const { base, started } = await setup({ webhookSecret: null });
    await fetch(`${base}/webhooks/whereby`, { method: "POST", body: webhook("assistant.requested", "/any") });
    expect(started).toEqual(["https://acme.whereby.com/any"]);
  });

  it("ignores join webhooks for rooms outside the pattern and for the Assistant itself", async () => {
    const { base, started } = await setup();
    for (const body of [webhook("room.client.joined", "/standup"), webhook("room.client.joined", "/visit-1", "assistant")]) {
      const response = await fetch(`${base}/webhooks/whereby`, { method: "POST", headers: { "whereby-signature": signature(body) }, body });
      expect(await response.json()).toMatchObject({ decision: "ignore" });
    }
    expect(started).toEqual([]);
  });

  it("serves the demo page with no data and strict headers", async () => {
    const { base } = await setup();
    const response = await fetch(`${base}/`);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await response.text()).toContain("Ambient scribe demo");
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
  });

  it("protects the API with the token", async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/api/sessions`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${base}/api/sessions`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/events?token=nope`)).status).toBe(401);
  });

  it("starts a session from the demo page, validating the room URL", async () => {
    const { base, started } = await setup();
    const post = (roomUrl: string) =>
      fetch(`${base}/api/sessions`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ roomUrl }) });
    expect((await post("https://evil.example.com/room")).status).toBe(400);
    const response = await post("https://acme.whereby.com/visit-7?roomKey=abc");
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "started" });
    expect(started).toEqual(["https://acme.whereby.com/visit-7"]);
  });

  it("streams a snapshot, then live updates, with keep-alive pings", async () => {
    const { base, memory } = await setup();
    memory.onSession({ sessionId: "s-1", roomUrl: "https://acme.whereby.com/visit-1", state: "live" });
    const response = await fetch(`${base}/api/events?token=${TOKEN}`);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      while (!text.includes(needle)) text += decoder.decode((await reader.read()).value);
    };

    await readUntil("event: snapshot");
    await readUntil("\n\n");
    const snapshot = JSON.parse(text.split("event: snapshot\ndata: ")[1]!.split("\n")[0]!);
    expect(snapshot).toMatchObject([{ info: { sessionId: "s-1", state: "live" }, running: false }]);

    memory.onTranscript("s-1", { id: "0-0", channel: 0, role: "doctor", text: "Hello", final: true, start: 0, end: 1 });
    await readUntil('"text":"Hello"');
    expect(text).toContain("event: update");
    await readUntil(": ping");
    await reader.cancel();
  });
});
