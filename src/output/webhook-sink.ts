import type { DraftNote, Fact, TranscriptSegment } from "../corti/types.js";
import { silentLogger, type Logger } from "../logger.js";
import type { OutputSink, SessionInfo } from "./sink.js";

/**
 * POSTs each event as JSON to a URL, standing in for the customer's backend.
 * Body: `{ type, sessionId, sentAt, data }`. Delivery is best effort: failures are
 * logged, not retried, and never slow down the session.
 */
export class WebhookSink implements OutputSink {
  constructor(
    private readonly url: URL,
    private readonly logger: Logger = silentLogger,
    private readonly timeoutMs = 5000,
  ) {}

  onSession(info: SessionInfo) {
    return this.post("session", info.sessionId, info);
  }
  onTranscript(sessionId: string, segment: TranscriptSegment) {
    return this.post("transcript", sessionId, segment);
  }
  onFacts(sessionId: string, facts: Fact[]) {
    return this.post("facts", sessionId, facts);
  }
  onNote(sessionId: string, note: DraftNote) {
    return this.post("note", sessionId, note);
  }
  onError(sessionId: string, message: string) {
    return this.post("error", sessionId, { message });
  }

  private async post(type: string, sessionId: string, data: unknown): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, sessionId, sentAt: new Date().toISOString(), data }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) this.logger.warn("Output webhook rejected an event", { type, status: response.status });
    } catch (error) {
      this.logger.warn("Output webhook failed", { type, error: String(error) });
    }
  }
}
