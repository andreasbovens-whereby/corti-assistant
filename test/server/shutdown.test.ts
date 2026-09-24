import { afterEach, describe, expect, it } from "vitest";
import { createCortiClient } from "../../src/corti/client.js";
import { Scribe } from "../../src/corti/scribe.js";
import { MemorySink } from "../../src/output/memory-sink.js";
import { SessionManager } from "../../src/server/session-manager.js";
import { CHANNEL_ROLES } from "../../src/session/channel-map.js";
import { Session } from "../../src/session/session.js";
import { FakeCorti, fakeCortiCredentials } from "../helpers/fake-corti.js";
import { FakeRoom } from "../helpers/fake-room.js";

let fake: FakeCorti | undefined;
afterEach(async () => {
  await fake?.stop();
  fake = undefined;
});

describe("Shutdown during calls", () => {
  it("ends every live session properly: notes generated, interactions completed, rooms left", async () => {
    fake = await FakeCorti.start();
    fake.onChunk = (connection, index) => {
      if (index === 2) connection.send({ type: "facts", fact: [{ id: `f-${connection.interactionId}`, text: "Headache", group: "history", groupId: "g", isDiscarded: false, source: "core", createdAt: "" }] });
    };
    const client = createCortiClient(
      { ...fakeCortiCredentials, region: "eu", primaryLanguage: "en", noteTemplateKey: "corti-soap", retentionPolicy: "none" },
      fake.urls,
    );
    const memory = new MemorySink();
    const rooms: FakeRoom[] = [];
    const manager = new SessionManager({
      maxSessions: 4,
      createSession: (roomUrl) => {
        const room = new FakeRoom(roomUrl);
        room.add({ id: "d", roleName: "owner" }, 440).talking = true;
        room.add({ id: "p", roleName: "granted_visitor" }, 1000).talking = true;
        rooms.push(room);
        const scribe = new Scribe({ client, channelRoles: CHANNEL_ROLES, language: "en", retentionPolicy: "none", templateKey: "corti-soap", endTimeoutMs: 2000 });
        return new Session({ room, scribe, sink: memory, clinicianPattern: null, endGraceMs: 30_000 });
      },
    });

    manager.start("https://acme.whereby.com/visit-1", "test");
    manager.start("https://acme.whereby.com/visit-2", "test");
    const deadline = Date.now() + 8000;
    while (memory.list().some((r) => r.facts.length === 0) || memory.list().length < 2) {
      if (Date.now() > deadline) throw new Error("sessions didn't get going");
      await new Promise((r) => setTimeout(r, 20));
    }

    await manager.shutdown(); // what SIGINT/SIGTERM does

    expect(manager.active).toHaveLength(0);
    for (const record of memory.list()) {
      expect(record.info).toMatchObject({ state: "ended", reason: "server shutting down" });
      expect(record.note?.basedOn).toBe("facts");
    }
    expect([...fake.interactions.values()].map((i) => i.statusHistory.at(-1))).toEqual(["completed", "completed"]);
    expect(fake.streams.every((s) => s.endReceived)).toBe(true);
    expect(rooms.every((r) => r.leaveCalls > 0)).toBe(true);
  }, 20_000);
});
