import "@whereby.com/assistant-sdk/polyfills";
import { EventEmitter } from "node:events";
import {
  ASSISTANT_LEFT_ROOM,
  Assistant,
  PARTICIPANT_AUDIO_TRACK_ADDED,
  PARTICIPANT_AUDIO_TRACK_REMOVED,
  type AudioSink,
  type RemoteParticipantState,
} from "@whereby.com/assistant-sdk";
import { silentLogger, type Logger } from "../logger.js";
import type { Room, RoomAudioTrack, RoomEvents, RoomParticipant } from "./room.js";

/** Joins a Whereby room as an Assistant and exposes per-participant audio tracks. */
export class WherebyRoom extends EventEmitter<RoomEvents> implements Room {
  readonly roomUrl: string;
  private readonly assistant: Assistant;
  private readonly logger: Logger;
  private readonly tracks = new Map<string, AudioSink>();
  private readonly unsubscribers: (() => void)[] = [];
  private hasLeft = false;

  constructor({ roomUrl, assistantKey, logger = silentLogger }: { roomUrl: string; assistantKey: string; logger?: Logger }) {
    super();
    this.roomUrl = roomUrl;
    this.logger = logger;
    // An Assistant can't be reused after leaving (NOTES.md), so each room gets its own.
    this.assistant = new Assistant({ assistantKey });
  }

  async join(): Promise<void> {
    const connection = this.assistant.getRoomConnection();

    // Subscribe before joining so no participant or track is missed.
    this.unsubscribers.push(
      connection.subscribeToRemoteParticipants((participants) => this.emit("participants", participants.map(toParticipant))),
      connection.subscribeToConnectionStatus((status) => {
        if (status === "disconnected" || status === "reconnecting") this.emit("connectionStatus", status);
      }),
    );

    this.assistant.on(PARTICIPANT_AUDIO_TRACK_ADDED, ({ participantId, trackId, data: sink }) => {
      // The SDK emits track events before participant subscribers run, so look the
      // participant up from the current state rather than from our last update.
      const state = connection.getState().remoteParticipants.find((p) => p.id === participantId);
      if (!state) {
        this.logger.warn("Audio track for an unknown participant; ignoring", { participantId, trackId });
        stopSink(sink);
        return;
      }
      this.tracks.set(trackId, sink);
      const track: RoomAudioTrack = {
        trackId,
        participant: toParticipant(state),
        subscribe: (onFrame) => {
          let first = true;
          sink.subscribe((frame) => {
            if (first) {
              first = false;
              // The frame format is only known at runtime; log it once per track.
              const { sampleRate, channelCount, bitsPerSample, numberOfFrames } = frame;
              this.logger.info("First audio frame", { trackId, sampleRate, channelCount, bitsPerSample, numberOfFrames, samples: frame.samples.length });
            }
            onFrame(frame);
          });
        },
        stop: () => this.stopTrack(trackId),
      };
      this.emit("audioTrackAdded", track);
    });
    this.assistant.on(PARTICIPANT_AUDIO_TRACK_REMOVED, ({ trackId }) => {
      this.stopTrack(trackId);
      this.emit("audioTrackRemoved", trackId);
    });
    this.assistant.on(ASSISTANT_LEFT_ROOM, () => this.handleLeft("assistant left or was removed from the room"));

    await this.assistant.joinRoom(this.roomUrl);
  }

  leave(): void {
    if (this.hasLeft) return;
    try {
      this.assistant.getRoomConnection().leaveRoom();
    } catch (error) {
      this.logger.warn("Error while leaving the room", { error: String(error) });
    }
    this.handleLeft("left");
  }

  private handleLeft(reason: string): void {
    if (this.hasLeft) return;
    this.hasLeft = true;
    for (const trackId of [...this.tracks.keys()]) this.stopTrack(trackId);
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.emit("left", reason);
  }

  private stopTrack(trackId: string): void {
    const sink = this.tracks.get(trackId);
    if (!sink) return;
    this.tracks.delete(trackId);
    stopSink(sink);
  }
}

function toParticipant(state: RemoteParticipantState): RoomParticipant {
  return {
    id: state.id,
    displayName: state.displayName,
    roleName: state.roleName,
    externalId: state.externalId,
  };
}

/**
 * The SDK's AudioSink wraps two native sinks: the one it extends and a private `_sink`
 * that `subscribe()` uses. Its `stop()` only stops the first, so stop both (NOTES.md).
 */
function stopSink(sink: AudioSink): void {
  const inner = (sink as unknown as { _sink?: { stop(): void; ondata?: unknown } })._sink;
  try {
    if (inner) {
      inner.ondata = undefined;
      inner.stop();
    }
    sink.stop();
  } catch {
    // Already stopped.
  }
}
