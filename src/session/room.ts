import type { EventEmitter } from "node:events";
import type { AudioFrame } from "../audio/pipeline.js";

export interface RoomParticipant {
  id: string;
  displayName: string;
  roleName: string;
  externalId: string | null;
}

export interface RoomAudioTrack {
  trackId: string;
  participant: RoomParticipant;
  /** Delivers this track's audio frames. One subscriber per track. */
  subscribe(onFrame: (frame: AudioFrame) => void): void;
  /** Stops delivery and releases the underlying sink. */
  stop(): void;
}

export interface RoomEvents {
  /** The current remote participants, whenever the list or their details change. */
  participants: [participants: RoomParticipant[]];
  audioTrackAdded: [track: RoomAudioTrack];
  audioTrackRemoved: [trackId: string];
  /** The assistant is no longer in the room (it left or was removed). */
  left: [reason: string];
  /** Connection problems that don't end the session, e.g. "reconnecting". */
  connectionStatus: [status: string];
}

/**
 * What a session needs from a video room. `WherebyRoom` implements it with the Whereby
 * Assistant SDK; tests use a fake. Keeping the SDK behind this interface also keeps its
 * quirks (see NOTES.md) in one file.
 */
export interface Room extends EventEmitter<RoomEvents> {
  readonly roomUrl: string;
  join(): Promise<void>;
  leave(): void;
}

/** Roles of bots and recorders, which never count as people in the call. */
const NON_HUMAN_ROLES = new Set(["recorder", "streamer", "captioner", "assistant"]);

export function isHuman(participant: RoomParticipant): boolean {
  return !NON_HUMAN_ROLES.has(participant.roleName);
}
