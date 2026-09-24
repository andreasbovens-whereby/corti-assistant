import type { DraftNote, Fact, TranscriptSegment } from "../corti/types.js";
import type { OutputSink, SessionInfo } from "./sink.js";

/**
 * Prints a session to the terminal, for manual mode. Shows final transcript segments
 * with the time since the session went live, which gives a rough speech-to-text latency.
 * Only for local testing with role-played calls: it prints clinical content.
 */
export class ConsoleSink implements OutputSink {
  private liveAt: number | undefined;

  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {}

  onSession(info: SessionInfo): void {
    if (info.state === "live") this.liveAt = Date.now();
    this.write(`\n== session ${info.state}${info.reason ? ` (${info.reason})` : ""}${info.interactionId ? ` · interaction ${info.interactionId}` : ""}`);
  }

  onTranscript(_sessionId: string, segment: TranscriptSegment): void {
    if (!segment.final) return;
    const received = this.liveAt === undefined ? "?" : ((Date.now() - this.liveAt) / 1000).toFixed(1);
    this.write(`[+${received}s] ${segment.role.padEnd(7)} (${segment.start}–${segment.end}) ${segment.text}`);
  }

  onFacts(_sessionId: string, facts: Fact[]): void {
    this.write(`-- facts (${facts.length}): ${facts.map((f) => `[${f.group}] ${f.text}`).join(" | ")}`);
  }

  onNote(_sessionId: string, note: DraftNote): void {
    this.write(`\n==== ${note.label} ====`);
    this.write(`template ${note.templateKey} · ${note.language} · based on ${note.basedOn}`);
    for (const section of note.sections) this.write(`\n## ${section.heading}\n${section.text}`);
    this.write("");
  }

  onError(_sessionId: string, message: string): void {
    this.write(`!! ${message}`);
  }
}
