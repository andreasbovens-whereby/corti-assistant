import { EventEmitter } from "node:events";
import type { DraftNote, Fact, TranscriptSegment } from "../corti/types.js";
import type { OutputSink, SessionInfo } from "./sink.js";

export interface SessionRecord {
  info: SessionInfo;
  /** Segments by id, in arrival order; interim segments are replaced by their final version. */
  transcript: TranscriptSegment[];
  facts: Fact[];
  note: DraftNote | undefined;
  errors: string[];
}

export type MemorySinkEvent =
  | { type: "session"; info: SessionInfo }
  | { type: "transcript"; sessionId: string; segment: TranscriptSegment }
  | { type: "facts"; sessionId: string; facts: Fact[] }
  | { type: "note"; sessionId: string; note: DraftNote }
  | { type: "error"; sessionId: string; message: string };

/**
 * Keeps each session's output in memory and re-emits every update as an `update` event.
 * The demo page reads the current state and streams the events.
 */
export class MemorySink extends EventEmitter<{ update: [event: MemorySinkEvent] }> implements OutputSink {
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(private readonly maxSessions = 50) {
    super();
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  onSession(info: SessionInfo): void {
    const record = this.sessions.get(info.sessionId);
    if (record) record.info = info;
    else {
      this.sessions.set(info.sessionId, { info, transcript: [], facts: [], note: undefined, errors: [] });
      this.evictOldest();
    }
    this.emit("update", { type: "session", info });
  }

  onTranscript(sessionId: string, segment: TranscriptSegment): void {
    const record = this.record(sessionId);
    const index = record.transcript.findIndex((s) => s.id === segment.id);
    if (index >= 0) record.transcript[index] = segment;
    else record.transcript.push(segment);
    this.emit("update", { type: "transcript", sessionId, segment });
  }

  onFacts(sessionId: string, facts: Fact[]): void {
    this.record(sessionId).facts = facts;
    this.emit("update", { type: "facts", sessionId, facts });
  }

  onNote(sessionId: string, note: DraftNote): void {
    this.record(sessionId).note = note;
    this.emit("update", { type: "note", sessionId, note });
  }

  onError(sessionId: string, message: string): void {
    this.record(sessionId).errors.push(message);
    this.emit("update", { type: "error", sessionId, message });
  }

  private record(sessionId: string): SessionRecord {
    let record = this.sessions.get(sessionId);
    if (!record) {
      record = { info: { sessionId, roomUrl: "", state: "starting" }, transcript: [], facts: [], note: undefined, errors: [] };
      this.sessions.set(sessionId, record);
    }
    return record;
  }

  /** Transcripts are patient data: keep only the most recent sessions. */
  private evictOldest(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}
