import { silentLogger, type Logger } from "../logger.js";
import type { Session } from "../session/session.js";

export type StartResult =
  | { status: "started"; sessionId: string }
  | { status: "already-running"; sessionId: string }
  | { status: "at-capacity" }
  | { status: "shutting-down" };

export interface SessionManagerOptions {
  createSession: (roomUrl: string) => Session;
  maxSessions: number;
  logger?: Logger;
}

/**
 * Runs at most one session per room. `room.client.joined` fires for every participant,
 * so a second trigger for a room with a live session is a no-op. A session that fails
 * or ends is removed, and the room can be scribed again later. Failures stay inside the
 * session (reported to its sink); they never affect other sessions.
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly createSession: (roomUrl: string) => Session;
  private readonly maxSessions: number;
  private readonly logger: Logger;
  private shuttingDown = false;

  constructor({ createSession, maxSessions, logger = silentLogger }: SessionManagerOptions) {
    this.createSession = createSession;
    this.maxSessions = maxSessions;
    this.logger = logger;
  }

  get active(): Session[] {
    return [...this.sessions.values()];
  }

  find(sessionId: string): Session | undefined {
    return this.active.find((s) => s.id === sessionId);
  }

  start(roomUrl: string, reason: string): StartResult {
    if (this.shuttingDown) return { status: "shutting-down" };
    const key = roomKey(roomUrl);
    const existing = this.sessions.get(key);
    if (existing) return { status: "already-running", sessionId: existing.id };
    if (this.sessions.size >= this.maxSessions) {
      this.logger.warn("At capacity; not starting a session", { maxSessions: this.maxSessions });
      return { status: "at-capacity" };
    }

    const session = this.createSession(key);
    // Registered before start() awaits anything, so a duplicate trigger arriving while
    // this one is still connecting sees it.
    this.sessions.set(key, session);
    this.logger.info("Starting session", { sessionId: session.id, reason });
    session.start().catch(() => {
      // Already reported to the sink and logged by the session.
    });
    void session.finished.then(() => {
      if (this.sessions.get(key) === session) this.sessions.delete(key);
    });
    return { status: "started", sessionId: session.id };
  }

  /** Ends every session (producing their notes) and refuses new ones. */
  async shutdown(timeoutMs = 60_000): Promise<void> {
    this.shuttingDown = true;
    const sessions = this.active;
    if (sessions.length === 0) return;
    this.logger.info("Ending open sessions for shutdown", { sessions: sessions.length });
    const ended = Promise.all(sessions.map((s) => s.end("server shutting down")));
    const timedOut = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs).unref());
    if ((await Promise.race([ended, timedOut])) === "timeout") {
      this.logger.warn("Some sessions didn't end in time", { timeoutMs });
    }
  }
}

/** One key per room, whatever query string or letter case the trigger used. */
export function roomKey(roomUrl: string): string {
  const url = new URL(roomUrl);
  return `https://${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
}
