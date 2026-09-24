import { AudioPipeline } from "../audio/pipeline.js";
import { systemClock, type Clock } from "../audio/clock.js";
import type { Scribe } from "../corti/scribe.js";
import { silentLogger, type Logger } from "../logger.js";
import type { OutputSink, SessionState } from "../output/sink.js";
import { CHANNEL_ROLES, ChannelMap } from "./channel-map.js";
import { isHuman, type Room, type RoomAudioTrack, type RoomParticipant } from "./room.js";

export interface SessionOptions {
  room: Room;
  scribe: Scribe;
  sink: OutputSink;
  clinicianPattern: RegExp | null;
  /** End this long after the last person leaves. */
  endGraceMs: number;
  /** End if nobody shows up within this time after joining (default 10 minutes). */
  noShowTimeoutMs?: number;
  logger?: Logger;
  clock?: Clock;
  /** Defaults to the room name plus a timestamp. Also the Corti encounter identifier. */
  id?: string;
  /** Receives every audio chunk sent to Corti (for local debugging, e.g. saving a WAV). */
  audioTap?: (chunk: Buffer) => void;
}

/**
 * One scribed call: the Assistant in a Whereby room, the audio pipeline, the Corti
 * interaction and the output sink.
 *
 * Start: create the Corti interaction and open the stream, join the room, start the
 * audio clock. End (room empty for the grace period, nobody showed up, the Assistant
 * left, or `end()` called): stop audio, end the stream, generate the note, mark the
 * interaction completed, leave the room. Corti problems mid-call are handled by the
 * scribe (it reconnects) and never end the Whereby side.
 */
export class Session {
  readonly id: string;
  readonly roomUrl: string;
  /** Resolves when the session has fully ended (or failed). Never rejects. */
  readonly finished: Promise<void>;
  private readonly room: Room;
  private readonly scribe: Scribe;
  private readonly sink: OutputSink;
  private readonly channelMap: ChannelMap;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly endGraceMs: number;
  private readonly noShowTimeoutMs: number;
  private readonly pipeline: AudioPipeline;
  private readonly tracks = new Map<string, RoomAudioTrack>();
  private participants: RoomParticipant[] = [];
  private currentState: SessionState = "starting";
  private seenHuman = false;
  private endTimer: unknown;
  private ending: Promise<void> | undefined;
  private resolveFinished!: () => void;

  constructor({ room, scribe, sink, clinicianPattern, endGraceMs, noShowTimeoutMs = 10 * 60_000, logger = silentLogger, clock = systemClock, id, audioTap }: SessionOptions) {
    this.room = room;
    this.roomUrl = room.roomUrl;
    this.scribe = scribe;
    this.sink = sink;
    this.channelMap = new ChannelMap(clinicianPattern);
    this.clock = clock;
    this.endGraceMs = endGraceMs;
    this.noShowTimeoutMs = noShowTimeoutMs;
    this.id = id ?? sessionId(room.roomUrl);
    this.logger = logger.child({ sessionId: this.id });
    this.finished = new Promise((resolve) => (this.resolveFinished = resolve));
    this.pipeline = new AudioPipeline({
      channelCount: CHANNEL_ROLES.length,
      clock,
      logger: this.logger,
      onChunk: (chunk) => {
        audioTap?.(chunk.data);
        this.scribe.sendAudio(chunk.data);
      },
    });

    scribe.on("transcript", (segment) => this.output((s) => s.onTranscript(this.id, segment)));
    scribe.on("facts", (facts) => this.output((s) => s.onFacts(this.id, facts)));
    scribe.on("warning", (message) => this.output((s) => s.onError(this.id, message)));
    room.on("participants", (participants) => this.handleParticipants(participants));
    room.on("audioTrackAdded", (track) => this.handleTrackAdded(track));
    room.on("audioTrackRemoved", (trackId) => this.handleTrackRemoved(trackId));
    room.on("connectionStatus", (status) => this.logger.warn("Whereby connection problem", { status }));
    room.on("left", (reason) => void this.end(`assistant left the room: ${reason}`));
  }

  get state(): SessionState {
    return this.currentState;
  }

  /** Rejects if the session couldn't start; the failure is also reported to the sink. */
  async start(): Promise<void> {
    this.report("starting");
    try {
      // Corti first: no point joining the call if we can't scribe it.
      await this.scribe.start(this.id);
    } catch (error) {
      this.fail(describe(error));
      throw error;
    }
    try {
      await this.room.join();
    } catch (error) {
      await this.scribe.cancel();
      this.fail(`Couldn't join the room: ${describe(error)}`);
      throw error;
    }
    if (this.ending) return; // the room ended the session while joining
    this.pipeline.start();
    this.report("live");
    this.scheduleEnd(this.noShowTimeoutMs, "nobody joined");
    // People may already have been in the room when we joined.
    this.handleParticipants(this.participants);
    this.logger.info("Session live", { interactionId: this.scribe.interactionId });
  }

  /** Ends the session and produces the note. Safe to call more than once. */
  end(reason: string): Promise<void> {
    this.ending ??= this.finish(reason);
    return this.ending;
  }

  private async finish(reason: string): Promise<void> {
    if (this.currentState === "failed") return;
    this.logger.info("Session ending", { reason });
    this.report("ending", reason);
    this.cancelEnd();
    this.pipeline.stop();
    for (const trackId of [...this.tracks.keys()]) this.handleTrackRemoved(trackId);

    await this.scribe.end();
    try {
      const note = await this.scribe.generateNote();
      await this.output((s) => s.onNote(this.id, note));
      this.logger.info("Draft note generated", { basedOn: note.basedOn, sections: note.sections.length });
    } catch (error) {
      this.logger.error("Couldn't generate the note", { error: describe(error) });
      await this.output((s) => s.onError(this.id, `Couldn't generate the note: ${describe(error)}`));
    }
    try {
      await this.scribe.complete();
    } catch (error) {
      this.logger.error("Couldn't mark the Corti interaction completed", { error: describe(error) });
    }
    this.room.leave();
    this.report("ended", reason);
    this.logger.info("Session ended", { reason, audio: this.pipeline.stats() });
    this.resolveFinished();
  }

  private handleParticipants(participants: RoomParticipant[]): void {
    this.participants = participants;
    if (this.currentState !== "live") return;
    if (participants.some(isHuman)) {
      this.seenHuman = true;
      this.cancelEnd();
    } else if (this.seenHuman && this.endTimer === undefined) {
      this.scheduleEnd(this.endGraceMs, "everyone left");
    }
  }

  private handleTrackAdded(track: RoomAudioTrack): void {
    if (this.ending || !isHuman(track.participant)) return;
    const present = this.participants.some((p) => p.id === track.participant.id)
      ? this.participants
      : [...this.participants, track.participant];
    const channel = this.channelMap.channelFor(track.participant, present);
    this.pipeline.addSource(track.trackId, channel);
    this.tracks.set(track.trackId, track);
    track.subscribe((frame) => this.pipeline.pushFrame(track.trackId, frame));
    // Participant ids and roles only: names are personal data and stay out of logs.
    this.logger.info("Participant audio mapped", {
      participantId: track.participant.id,
      roleName: track.participant.roleName,
      channel,
      role: CHANNEL_ROLES[channel],
    });
    if (this.currentState === "live") {
      this.seenHuman = true;
      this.cancelEnd();
    }
  }

  private handleTrackRemoved(trackId: string): void {
    const track = this.tracks.get(trackId);
    if (!track) return;
    this.tracks.delete(trackId);
    this.pipeline.removeSource(trackId);
    track.stop();
  }

  private scheduleEnd(delayMs: number, reason: string): void {
    this.cancelEnd();
    this.endTimer = this.clock.setTimeout(() => void this.end(reason), delayMs);
  }

  private cancelEnd(): void {
    if (this.endTimer !== undefined) this.clock.clearTimeout(this.endTimer);
    this.endTimer = undefined;
  }

  private fail(reason: string): void {
    this.logger.error("Session failed", { reason });
    void this.output((s) => s.onError(this.id, reason));
    this.report("failed", reason);
    this.cancelEnd();
    this.pipeline.stop();
    this.room.leave();
    this.resolveFinished();
  }

  private report(state: SessionState, reason?: string): void {
    this.currentState = state;
    const interactionId = this.scribe.interactionId;
    void this.output((s) =>
      s.onSession({
        sessionId: this.id,
        roomUrl: this.roomUrl,
        state,
        ...(interactionId ? { interactionId } : {}),
        ...(reason ? { reason } : {}),
      }),
    );
  }

  /** Calls the sink, so that a failing sink never breaks the session. */
  private async output(call: (sink: OutputSink) => void | Promise<void>): Promise<void> {
    try {
      await call(this.sink);
    } catch (error) {
      this.logger.error("Output sink failed", { error: describe(error) });
    }
  }
}

/** "https://acme.whereby.com/visit-42?x" -> "visit-42-20260924T101500Z" */
export function sessionId(roomUrl: string, now = new Date()): string {
  const name = new URL(roomUrl).pathname.split("/").filter(Boolean).pop() ?? "room";
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  return `${name}-${stamp}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
