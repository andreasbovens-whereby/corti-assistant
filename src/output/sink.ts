import type { DraftNote, Fact, TranscriptSegment } from "../corti/types.js";

export type SessionState = "starting" | "live" | "ending" | "ended" | "failed";

export interface SessionInfo {
  sessionId: string;
  roomUrl: string;
  state: SessionState;
  interactionId?: string;
  /** Why the session ended or failed. */
  reason?: string;
}

/**
 * Where a session's results go. Implementations must not throw; the session also guards
 * against it. None of this is ever posted to the Whereby room chat, which the patient sees.
 */
export interface OutputSink {
  onSession(info: SessionInfo): void | Promise<void>;
  onTranscript(sessionId: string, segment: TranscriptSegment): void | Promise<void>;
  /** The full current list of facts. */
  onFacts(sessionId: string, facts: Fact[]): void | Promise<void>;
  /** The draft note. Always labelled as a draft for clinician review. */
  onNote(sessionId: string, note: DraftNote): void | Promise<void>;
  onError(sessionId: string, message: string): void | Promise<void>;
}

/** Sends everything to several sinks, e.g. the demo page and a customer webhook. */
export class CompositeSink implements OutputSink {
  private readonly sinks: OutputSink[];

  constructor(...sinks: OutputSink[]) {
    this.sinks = sinks;
  }

  onSession(info: SessionInfo) {
    return this.all((s) => s.onSession(info));
  }
  onTranscript(sessionId: string, segment: TranscriptSegment) {
    return this.all((s) => s.onTranscript(sessionId, segment));
  }
  onFacts(sessionId: string, facts: Fact[]) {
    return this.all((s) => s.onFacts(sessionId, facts));
  }
  onNote(sessionId: string, note: DraftNote) {
    return this.all((s) => s.onNote(sessionId, note));
  }
  onError(sessionId: string, message: string) {
    return this.all((s) => s.onError(sessionId, message));
  }

  private async all(call: (sink: OutputSink) => void | Promise<void>): Promise<void> {
    await Promise.allSettled(this.sinks.map(async (sink) => call(sink)));
  }
}
