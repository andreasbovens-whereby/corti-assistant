import { EventEmitter } from "node:events";
import type { AudioFrame } from "../../src/audio/pipeline.js";
import type { Room, RoomAudioTrack, RoomEvents, RoomParticipant } from "../../src/session/room.js";
import { sine } from "./signals.js";

const FRAME_MS = 20;
const RATE = 48_000;

/** A person in the fake room who "speaks" a sine tone while talking. */
export class FakePerson {
  talking = false;
  private timer: NodeJS.Timeout | undefined;
  private frames = 0;
  private listener: ((frame: AudioFrame) => void) | undefined;
  readonly trackId: string;

  constructor(
    readonly participant: RoomParticipant,
    readonly toneHz: number,
  ) {
    this.trackId = `track-${participant.id}`;
  }

  track(room: FakeRoom): RoomAudioTrack {
    return {
      trackId: this.trackId,
      participant: this.participant,
      subscribe: (onFrame) => {
        this.listener = onFrame;
        this.startFrames();
      },
      stop: () => {
        room.stoppedTracks.push(this.trackId);
        this.stopFrames();
      },
    };
  }

  /** Delivers 20 ms frames in real time: silence, or the tone while `talking`. */
  private startFrames(): void {
    const size = (RATE * FRAME_MS) / 1000;
    this.timer = setInterval(() => {
      const samples = this.talking ? sine(this.toneHz, RATE, size, 12_000, this.frames * size) : new Int16Array(size);
      this.frames++;
      this.listener?.({ samples, sampleRate: RATE, channelCount: 1, bitsPerSample: 16, numberOfFrames: size });
    }, FRAME_MS);
  }

  stopFrames(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.listener = undefined;
  }
}

/** In-memory stand-in for a Whereby room. */
export class FakeRoom extends EventEmitter<RoomEvents> implements Room {
  readonly roomUrl: string;
  readonly people = new Map<string, FakePerson>();
  readonly stoppedTracks: string[] = [];
  joined = false;
  leaveCalls = 0;
  failJoin: Error | undefined;

  constructor(roomUrl = "https://acme.whereby.com/visit-42") {
    super();
    this.roomUrl = roomUrl;
  }

  async join(): Promise<void> {
    if (this.failJoin) throw this.failJoin;
    this.joined = true;
    this.emitParticipants();
    for (const person of this.people.values()) this.emit("audioTrackAdded", person.track(this));
  }

  leave(): void {
    this.leaveCalls++;
    if (!this.joined) return;
    this.joined = false;
    for (const person of this.people.values()) person.stopFrames();
    this.emit("left", "left");
  }

  /** Adds a person; if the assistant is in the room, their track appears right away. */
  add(participant: Partial<RoomParticipant> & { id: string }, toneHz: number): FakePerson {
    const person = new FakePerson({ displayName: participant.id, roleName: "visitor", externalId: null, ...participant }, toneHz);
    this.people.set(participant.id, person);
    if (this.joined) {
      this.emit("audioTrackAdded", person.track(this));
      this.emitParticipants();
    }
    return person;
  }

  remove(id: string): void {
    const person = this.people.get(id);
    if (!person) return;
    this.people.delete(id);
    person.stopFrames();
    this.emit("audioTrackRemoved", person.trackId);
    this.emitParticipants();
  }

  /** The assistant gets removed from the room by someone else. */
  kick(): void {
    this.joined = false;
    for (const person of this.people.values()) person.stopFrames();
    this.emit("left", "kicked");
  }

  private emitParticipants(): void {
    this.emit("participants", [...this.people.values()].map((p) => p.participant));
  }
}
