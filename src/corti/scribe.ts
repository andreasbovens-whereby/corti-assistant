import { EventEmitter } from "node:events";
import type { Corti, CortiClient } from "@corti/sdk";
import { audioFormat } from "../audio/pipeline.js";
import { silentLogger, type Logger } from "../logger.js";
import { DRAFT_LABEL, type DraftNote, type Fact, type SpeakerRole, type TranscriptSegment } from "./types.js";

type StreamSocket = Awaited<ReturnType<CortiClient["stream"]["connect"]>>;

export type ScribeState = "idle" | "connecting" | "streaming" | "reconnecting" | "ending" | "ended" | "failed";

export interface ScribeEvents {
  state: [state: ScribeState];
  transcript: [segment: TranscriptSegment];
  /** The full current list of facts (discarded ones removed) after every update. */
  facts: [facts: Fact[]];
  /** Non-fatal problems: errors reported by Corti, connection drops. */
  warning: [message: string, details?: Record<string, unknown>];
}

export interface ScribeOptions {
  client: CortiClient;
  /** Role per channel; the array length is the stream's channel count. */
  channelRoles: SpeakerRole[];
  language: string;
  retentionPolicy: "none" | "retain";
  templateKey: string;
  logger?: Logger;
  /** How long to wait for CONFIG_ACCEPTED on each connection attempt. */
  configTimeoutMs?: number;
  /** How long to wait for ENDED after sending `end`. */
  endTimeoutMs?: number;
  reconnectDelayMs?: { initial: number; max: number };
}

const OPEN = 1;

/**
 * One Corti ambient-documentation interaction, from creation to the final note:
 * create → in-progress → stream (with reconnects) → end → document → completed.
 *
 * Reconnection is handled here rather than by the SDK's ReconnectingWebSocket, which
 * would reuse the original (possibly expired) token and flush queued audio before
 * re-sending the config (see NOTES.md). On any unexpected close we close the SDK socket
 * and open a fresh one with `stream.connect()`, which fetches a current token and waits
 * for CONFIG_ACCEPTED again. Audio produced while disconnected is dropped, not queued,
 * so the stream never runs faster than real time.
 */
export class Scribe extends EventEmitter<ScribeEvents> {
  private readonly options: Required<Omit<ScribeOptions, "logger">>;
  private readonly logger: Logger;
  private currentState: ScribeState = "idle";
  private id: string | undefined;
  private identifier = "";
  private socket: StreamSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectAttempt = 0;
  private droppedChunks = 0;
  private endedWaiter: (() => void) | undefined;
  private readonly finalSegments: TranscriptSegment[] = [];
  /** Per channel: how many final segments so far, used to name the next segment. */
  private readonly segmentCounters = new Map<number, number>();
  private interimCount = 0;
  private readonly facts = new Map<string, Fact>();

  constructor({ logger = silentLogger, ...options }: ScribeOptions) {
    super();
    this.options = {
      configTimeoutMs: 10_000,
      endTimeoutMs: 30_000,
      reconnectDelayMs: { initial: 1000, max: 30_000 },
      ...options,
    };
    this.logger = logger;
  }

  get state(): ScribeState {
    return this.currentState;
  }

  get interactionId(): string | undefined {
    return this.id;
  }

  /** Final transcript segments in arrival order. */
  get transcript(): TranscriptSegment[] {
    return [...this.finalSegments];
  }

  get currentFacts(): Fact[] {
    return [...this.facts.values()];
  }

  /** Creates the interaction, marks it in progress and opens the stream. Resolves once Corti accepts the config. */
  async start(identifier: string): Promise<void> {
    if (this.currentState !== "idle") throw new Error(`Scribe already started (state: ${this.currentState})`);
    this.identifier = identifier;
    this.setState("connecting");
    try {
      const { interactionId } = await this.options.client.interactions.create({
        encounter: { identifier, status: "planned", type: "first_consultation", title: identifier },
      });
      this.id = interactionId;
      this.logger.info("Corti interaction created", { interactionId });
      await this.setEncounterStatus("in-progress");
      this.socket = await this.connect();
      this.setState("streaming");
    } catch (error) {
      this.setState("failed");
      throw new Error(`Couldn't start Corti interaction: ${describe(error)}`, { cause: error });
    }
  }

  /** Sends one chunk of audio. Returns false if it was dropped because the stream isn't ready. */
  sendAudio(chunk: Buffer): boolean {
    const socket = this.socket;
    if (this.currentState !== "streaming" || !socket || socket.readyState !== OPEN) {
      this.droppedChunks++;
      return false;
    }
    try {
      // sendAudio refuses a socket that isn't open; plain send() would queue it (see NOTES.md).
      socket.sendAudio(chunk);
      return true;
    } catch {
      this.droppedChunks++;
      return false;
    }
  }

  /** Sends `end` and waits for Corti's final updates (ENDED), then closes the stream. */
  async end(): Promise<void> {
    if (this.currentState === "ended" || this.currentState === "ending") return;
    const wasStreaming = this.currentState === "streaming";
    this.setState("ending");
    this.stopReconnecting();

    const socket = this.socket;
    if (wasStreaming && socket && socket.readyState === OPEN) {
      const ended = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), this.options.endTimeoutMs);
        this.endedWaiter = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      socket.sendEnd({ type: "end" });
      if (!(await ended)) this.warn("Corti didn't confirm the end of the stream in time", { timeoutMs: this.options.endTimeoutMs });
    } else {
      this.warn("Stream wasn't connected at the end; the note uses what arrived before", { state: this.currentState });
    }
    this.closeSocket();
    this.setState("ended");
    if (this.droppedChunks > 0) this.logger.info("Audio chunks dropped while disconnected", { chunks: this.droppedChunks });
    this.logger.info("Transcript received", { finalSegments: this.finalSegments.length, interimResults: this.interimCount, facts: this.facts.size });
  }

  /**
   * Generates the draft note. Uses the facts when there are any (the ambient workflow's
   * intended input), otherwise the final transcript. With retention "none" Corti keeps
   * neither, so both come from what we collected on the stream.
   */
  async generateNote(): Promise<DraftNote> {
    const interactionId = this.requireInteraction();
    const facts = this.currentFacts;
    const transcript = this.transcript;
    let basedOn: DraftNote["basedOn"];
    let context: Corti.DocumentsContext[];
    if (facts.length > 0) {
      basedOn = "facts";
      context = [{ type: "facts", data: facts.map(({ text, group, source }) => ({ text, group, source: toSource(source) })) }];
    } else if (transcript.length > 0) {
      basedOn = "transcript";
      context = transcript.map((s) => ({ type: "transcript", data: { text: s.text, channel: s.channel } }));
    } else {
      throw new Error("Nothing to generate a note from: no facts and no transcript");
    }

    const document = await this.options.client.documents.classic.create(interactionId, {
      templateKey: this.options.templateKey,
      outputLanguage: this.options.language,
      name: `Draft note: ${this.identifier}`,
      context,
    });
    return {
      status: "draft",
      label: DRAFT_LABEL,
      interactionId,
      documentId: document.id,
      templateKey: this.options.templateKey,
      language: this.options.language,
      basedOn,
      sections: [...document.sections]
        .sort((a, b) => a.sort - b.sort)
        .map(({ key, name, text }) => ({ key, heading: name, text: withoutBareHeading(text, name) })),
      generatedAt: new Date().toISOString(),
    };
  }

  /** Marks the interaction completed. */
  async complete(): Promise<void> {
    await this.setEncounterStatus("completed");
  }

  /** Stops streaming without the end handshake, and marks the interaction cancelled if it exists. */
  async cancel(): Promise<void> {
    this.stopReconnecting();
    this.closeSocket();
    this.setState("ended");
    if (this.id) await this.setEncounterStatus("cancelled").catch((error) => this.warn("Couldn't cancel interaction", { error: describe(error) }));
  }

  private streamConfig(): Corti.StreamConfig {
    const { channelRoles, language, retentionPolicy } = this.options;
    return {
      transcription: {
        primaryLanguage: language,
        isMultichannel: channelRoles.length > 1,
        participants: channelRoles.map((role, channel) => ({ channel, role })),
      },
      mode: { type: "facts", outputLocale: language, factGenerationInterval: "fast_init" },
      audioFormat: audioFormat(channelRoles.length),
      retentionPolicy,
    };
  }

  /**
   * Opens a stream connection and resolves after CONFIG_ACCEPTED.
   *
   * We wait for the config ourselves instead of using the SDK's `awaitConfiguration`:
   * when a connection fails before it opens, the SDK's ack promise rejects with no
   * handler attached, and an unhandled rejection crashes the Node process (NOTES.md).
   */
  private async connect(): Promise<StreamSocket> {
    const socket = await this.options.client.stream.connect({
      id: this.requireInteraction(),
      configuration: this.streamConfig(),
      awaitConfiguration: false,
      // One attempt per connect(): retries happen here, with a fresh token each time.
      reconnectAttempts: 1,
    });
    try {
      await this.waitForConfigAccepted(socket);
    } catch (error) {
      socket.close();
      throw error;
    }
    socket.on("message", (message) => this.handleMessage(message));
    socket.on("close", (event) => this.handleDisconnect(socket, `closed (code ${event.code})`));
    socket.on("error", (error) => {
      // The SDK reports unparseable messages as errors on a healthy socket.
      if (error.message === "Received unknown message type") this.logger.debug("Ignored unknown stream message");
      else this.handleDisconnect(socket, error.message);
    });
    return socket;
  }

  private waitForConfigAccepted(socket: StreamSocket): Promise<void> {
    const raw = socket.socket;
    const timeoutMs = this.options.configTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        clearTimeout(timer);
        raw.removeEventListener("message", onMessage);
        raw.removeEventListener("error", onError);
        raw.removeEventListener("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (event: { data: unknown }) => {
        const type = messageType(event.data);
        if (type === "CONFIG_ACCEPTED" || type === "CONFIG_ALREADY_RECEIVED") settle();
        else if (type === "CONFIG_DENIED" || type === "CONFIG_MISSING" || type === "CONFIG_NOT_PROVIDED" || type === "ENDED") {
          settle(new Error(`Corti rejected the stream config: ${type}`));
        }
      };
      const onError = (event: { message?: string }) => settle(new Error(`Stream connection failed: ${event.message ?? "unknown error"}`));
      const onClose = (event: { code?: number }) => settle(new Error(`Stream closed before the config was accepted (code ${event.code})`));
      const timer = setTimeout(() => settle(new Error(`Corti didn't accept the stream config within ${timeoutMs} ms`)), timeoutMs);
      raw.addEventListener("message", onMessage);
      raw.addEventListener("error", onError);
      raw.addEventListener("close", onClose);
    });
  }

  private handleDisconnect(socket: StreamSocket, reason: string): void {
    if (socket !== this.socket || this.currentState !== "streaming") return;
    this.warn("Corti stream disconnected; reconnecting", { reason });
    this.closeSocket();
    this.setState("reconnecting");
    this.reconnectAttempt = 0;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const { initial, max } = this.options.reconnectDelayMs;
    const delay = Math.min(max, initial * 2 ** this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        const socket = await this.connect();
        if (this.currentState !== "reconnecting") {
          // end() or cancel() was called while connecting.
          socket.close();
          return;
        }
        this.socket = socket;
        this.setState("streaming");
        this.logger.info("Corti stream reconnected", { attempts: this.reconnectAttempt, droppedChunks: this.droppedChunks });
      } catch (error) {
        if (this.currentState !== "reconnecting") return;
        this.warn("Corti reconnect failed", { attempt: this.reconnectAttempt, error: describe(error) });
        this.scheduleReconnect();
      }
    }, delay);
  }

  private stopReconnecting(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    // close() also cancels any reconnect the SDK scheduled.
    socket?.close();
  }

  /** Messages are passed through unvalidated, so unknown types can arrive too. */
  private handleMessage(message: { type: string }): void {
    switch (message.type) {
      case "transcript":
        for (const item of (message as Corti.StreamTranscriptMessage).data) this.addSegment(item);
        break;
      case "facts":
        this.updateFacts((message as Corti.StreamFactsMessage).fact);
        break;
      case "ENDED":
        this.endedWaiter?.();
        this.endedWaiter = undefined;
        break;
      case "error": {
        const { error } = message as Corti.StreamErrorMessage;
        this.warn("Corti reported a stream error", { id: error.id, title: error.title, status: error.status, details: error.details });
        break;
      }
      case "usage":
        this.logger.info("Corti stream usage", { credits: (message as Corti.StreamUsageMessage).credits });
        break;
      default:
        this.logger.debug("Corti stream message", { type: message.type });
    }
  }

  /**
   * Corti's `id` on a transcript item is the interaction id, the same for every segment,
   * so segments get their own ids: `<channel>-<n>`. Interim results on a channel keep
   * the id of the segment in progress until its final version arrives, so consumers can
   * replace interim text in place.
   */
  private addSegment(item: Corti.StreamTranscript): void {
    const channel = item.participant?.channel ?? 0;
    const index = this.segmentCounters.get(channel) ?? 0;
    const segment: TranscriptSegment = {
      id: `${channel}-${index}`,
      channel,
      role: this.options.channelRoles[channel] ?? "multiple",
      text: item.transcript,
      final: item.final,
      start: item.time?.start ?? 0,
      end: item.time?.end ?? 0,
    };
    if (segment.final) {
      this.finalSegments.push(segment);
      this.segmentCounters.set(channel, index + 1);
    } else {
      this.interimCount++;
    }
    this.emit("transcript", segment);
  }

  private updateFacts(updates: Corti.StreamFact[]): void {
    for (const fact of updates) {
      if (fact.isDiscarded) this.facts.delete(fact.id);
      else this.facts.set(fact.id, { id: fact.id, text: fact.text, group: fact.group, source: fact.source });
    }
    this.emit("facts", this.currentFacts);
  }

  private async setEncounterStatus(status: Corti.InteractionsEncounterStatusEnum): Promise<void> {
    await this.options.client.interactions.update(this.requireInteraction(), { encounter: { status } });
    this.logger.info("Corti interaction status updated", { interactionId: this.id, status });
  }

  private requireInteraction(): string {
    if (!this.id) throw new Error("No Corti interaction yet");
    return this.id;
  }

  private setState(state: ScribeState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.emit("state", state);
  }

  private warn(message: string, details?: Record<string, unknown>): void {
    this.logger.warn(message, details);
    this.emit("warning", message, details);
  }
}

/** Corti returns an empty section as just its heading (e.g. "Objective:"); treat that as empty. */
function withoutBareHeading(text: string, heading: string): string {
  return text.trim().replace(/:$/, "").toLowerCase() === heading.trim().toLowerCase() ? "" : text;
}

function toSource(source: string): Corti.CommonSourceEnum | undefined {
  return source === "core" || source === "system" || source === "user" ? source : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageType(data: unknown): string | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const parsed = JSON.parse(data) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}
