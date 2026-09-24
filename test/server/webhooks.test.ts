import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decide, verifySignature } from "../../src/server/webhooks.js";

const SECRET = "whsec-test";
const sign = (body: string, t: number, secret = SECRET) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

describe("verifySignature", () => {
  const body = JSON.stringify({ type: "room.client.joined", data: { roomName: "/visit" } });
  const now = 1_790_000_000;

  it("accepts a valid signature", () => {
    expect(verifySignature(sign(body, now), body, SECRET, now)).toBe(true);
  });

  it("accepts a signature over the re-serialized body, as in Whereby's example", () => {
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifySignature(sign(body, now), pretty, SECRET, now)).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["a wrong secret", sign(body, now, "other")],
    ["a tampered body", sign(body.replace("visit", "other"), now)],
    ["an old timestamp (replay)", sign(body, now - 600)],
    ["a malformed header", "v1=abc"],
  ])("rejects %s", (_, header) => {
    expect(verifySignature(header, body, SECRET, now)).toBe(false);
  });
});

describe("decide", () => {
  const joined = (roomName: string, roleName = "visitor") => ({
    type: "room.client.joined",
    data: { roomName, subdomain: "acme", roleName, participantId: "p", externalId: null },
  });

  it("starts on an in-room invite, regardless of the room pattern", () => {
    expect(decide({ type: "assistant.requested", data: { roomName: "/any-room", subdomain: "acme" } }, null)).toEqual({
      action: "start",
      roomUrl: "https://acme.whereby.com/any-room",
      reason: "invited from the room",
    });
  });

  it("starts when a person joins a matching room", () => {
    expect(decide(joined("/visit-42"), /^\/visit-/)).toMatchObject({ action: "start", roomUrl: "https://acme.whereby.com/visit-42" });
  });

  it("ignores rooms that don't match, and does nothing without a pattern", () => {
    expect(decide(joined("/team-standup"), /^\/visit-/)).toMatchObject({ action: "ignore" });
    expect(decide(joined("/visit-42"), null)).toMatchObject({ action: "ignore", reason: expect.stringContaining("TRIGGER_ROOM_PATTERN") });
  });

  it("ignores its own Assistant (and other bots) joining", () => {
    for (const role of ["assistant", "recorder", "streamer", "captioner"]) {
      expect(decide(joined("/visit-42", role), /^\/visit-/)).toMatchObject({ action: "ignore" });
    }
  });

  it("ignores other events and malformed payloads", () => {
    expect(decide({ type: "room.session.ended", data: { roomName: "/visit-42", subdomain: "acme" } }, /./)).toMatchObject({ action: "ignore" });
    expect(decide({ type: "room.client.joined" }, /./)).toMatchObject({ action: "ignore", reason: "no room in payload" });
  });
});
