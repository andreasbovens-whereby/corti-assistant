import { describe, expect, it } from "vitest";
import { roomKey, SessionManager } from "../../src/server/session-manager.js";
import type { Session } from "../../src/session/session.js";

/** Just enough of a Session for the manager. */
function fakeSession(roomUrl: string, { failStart = false } = {}) {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const session = {
    id: `session-${roomUrl.split("/").pop()}`,
    roomUrl,
    finished,
    started: 0,
    endReasons: [] as string[],
    start: async () => {
      session.started++;
      if (failStart) {
        finish();
        throw new Error("could not start");
      }
    },
    end: async (reason: string) => {
      session.endReasons.push(reason);
      finish();
    },
    finish,
  };
  return session;
}

function setup(maxSessions = 2, options: { failStart?: boolean } = {}) {
  const created: ReturnType<typeof fakeSession>[] = [];
  const manager = new SessionManager({
    maxSessions,
    createSession: (roomUrl) => {
      const session = fakeSession(roomUrl, options);
      created.push(session);
      return session as unknown as Session;
    },
  });
  return { manager, created };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SessionManager", () => {
  it("runs one session per room, however many join webhooks arrive", () => {
    const { manager, created } = setup();
    expect(manager.start("https://acme.whereby.com/visit-1", "joined")).toMatchObject({ status: "started" });
    expect(manager.start("https://acme.whereby.com/visit-1", "joined")).toMatchObject({ status: "already-running" });
    expect(manager.start("https://ACME.whereby.com/visit-1/?roomKey=x", "joined")).toMatchObject({ status: "already-running" });
    expect(created).toHaveLength(1);
    expect(created[0]!.started).toBe(1);
  });

  it("allows the room again after its session ends", async () => {
    const { manager, created } = setup();
    manager.start("https://acme.whereby.com/visit-1", "joined");
    created[0]!.finish();
    await tick();
    expect(manager.active).toHaveLength(0);
    expect(manager.start("https://acme.whereby.com/visit-1", "joined")).toMatchObject({ status: "started" });
  });

  it("removes a session that fails to start, without affecting others", async () => {
    const { manager, created } = setup(2);
    manager.start("https://acme.whereby.com/visit-1", "joined");
    const failing = new SessionManager({
      maxSessions: 2,
      createSession: (roomUrl) => fakeSession(roomUrl, { failStart: true }) as unknown as Session,
    });
    failing.start("https://acme.whereby.com/visit-2", "joined");
    await tick();
    expect(failing.active).toHaveLength(0);
    expect(manager.active.map((s) => s.id)).toEqual([created[0]!.id]);
  });

  it("refuses new sessions at capacity", () => {
    const { manager } = setup(1);
    manager.start("https://acme.whereby.com/visit-1", "joined");
    expect(manager.start("https://acme.whereby.com/visit-2", "joined")).toEqual({ status: "at-capacity" });
  });

  it("ends every session on shutdown and refuses new ones", async () => {
    const { manager, created } = setup();
    manager.start("https://acme.whereby.com/visit-1", "joined");
    manager.start("https://acme.whereby.com/visit-2", "joined");
    await manager.shutdown();
    expect(created.map((s) => s.endReasons)).toEqual([["server shutting down"], ["server shutting down"]]);
    expect(manager.start("https://acme.whereby.com/visit-3", "joined")).toEqual({ status: "shutting-down" });
  });

  it("normalizes room URLs", () => {
    expect(roomKey("https://Acme.Whereby.com/visit-1/?roomKey=secret")).toBe("https://acme.whereby.com/visit-1");
  });
});
