import { createHmac, timingSafeEqual } from "node:crypto";

/** How old a signed webhook may be before it's rejected as a possible replay. */
const MAX_AGE_SECONDS = 5 * 60;

/**
 * Verifies a `Whereby-Signature` header (`t=<unix seconds>,v1=<hex HMAC-SHA256>`),
 * signed over `<t>.<body>` with the webhook's secret from the Whereby dashboard.
 */
export function verifySignature(header: string | undefined, rawBody: string, secret: string, nowSeconds = Date.now() / 1000): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => part.trim().split("=", 2) as [string, string]));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_AGE_SECONDS) return false;

  // Whereby's example signs JSON.stringify(parsed body); that's normally identical to the
  // raw body, but check both so whitespace differences can't cause false rejections.
  const candidates = [rawBody];
  try {
    const normalized = JSON.stringify(JSON.parse(rawBody));
    if (normalized !== rawBody) candidates.push(normalized);
  } catch {
    return false;
  }
  const expected = Buffer.from(signature, "hex");
  return candidates.some((body) => {
    const actual = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

export interface WherebyWebhook {
  type: string;
  id?: string;
  data?: {
    roomName?: string;
    subdomain?: string;
    roleName?: string;
    externalId?: string | null;
    participantId?: string;
    [key: string]: unknown;
  };
}

export type WebhookDecision = { action: "start"; roomUrl: string; reason: string } | { action: "ignore"; reason: string };

/** Roles of clients that must never trigger a session (including our own Assistant joining). */
const NON_HUMAN_ROLES = new Set(["assistant", "recorder", "streamer", "captioner"]);

/**
 * Decides what to do with a webhook. Starts a session when a host invites the Assistant
 * from the room (`assistant.requested`), or when a person joins a room whose name
 * matches `triggerRoomPattern`. Duplicate starts are the session manager's concern.
 */
export function decide(webhook: WherebyWebhook, triggerRoomPattern: RegExp | null): WebhookDecision {
  const roomName = webhook.data?.roomName;
  const subdomain = webhook.data?.subdomain;
  if (!roomName || !subdomain) return { action: "ignore", reason: "no room in payload" };
  const roomUrl = `https://${subdomain}.whereby.com${roomName.startsWith("/") ? roomName : `/${roomName}`}`;

  switch (webhook.type) {
    case "assistant.requested":
      return { action: "start", roomUrl, reason: "invited from the room" };
    case "room.client.joined": {
      const role = webhook.data?.roleName ?? "";
      if (NON_HUMAN_ROLES.has(role)) return { action: "ignore", reason: `bot joined (${role})` };
      if (!triggerRoomPattern) return { action: "ignore", reason: "automatic joining is off (TRIGGER_ROOM_PATTERN not set)" };
      if (!triggerRoomPattern.test(roomName)) return { action: "ignore", reason: "room doesn't match TRIGGER_ROOM_PATTERN" };
      return { action: "start", roomUrl, reason: "participant joined" };
    }
    default:
      return { action: "ignore", reason: `event ${webhook.type} isn't a trigger` };
  }
}
