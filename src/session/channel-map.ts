import type { SpeakerRole } from "../corti/types.js";
import type { RoomParticipant } from "./room.js";

export const DOCTOR_CHANNEL = 0;
export const PATIENT_CHANNEL = 1;
/** Channel roles for the Corti stream config. */
export const CHANNEL_ROLES: SpeakerRole[] = ["doctor", "patient"];

/** Roles that count as "the host" for the doctor fallback. */
const HOST_ROLES = new Set(["host", "owner"]);

/**
 * Decides which Corti channel a participant's audio goes to.
 *
 * - Channel 0 (doctor): a participant whose `externalId` matches the clinician pattern.
 *   If nobody present matches it (or no pattern is set), the room host: role `host`,
 *   or `owner` for the room's owner (seen live; the SDK's RoleName type omits it).
 * - Channel 1 (patient): everyone else. A third or fourth person is mixed into this
 *   channel; in telehealth that's usually a relative or interpreter (see NOTES.md).
 *
 * Only one person holds the doctor channel at a time. When the holder leaves, the next
 * clinician to join takes it, and so does the same clinician rejoining.
 */
export class ChannelMap {
  private doctorId: string | undefined;

  constructor(private readonly clinicianPattern: RegExp | null) {}

  /** `present` is everyone currently in the room, including `participant`. */
  channelFor(participant: RoomParticipant, present: RoomParticipant[]): number {
    const holderPresent = this.doctorId !== undefined && present.some((p) => p.id === this.doctorId);
    if (participant.id === this.doctorId && holderPresent) return DOCTOR_CHANNEL;
    if (!holderPresent && this.isClinician(participant, present)) {
      this.doctorId = participant.id;
      return DOCTOR_CHANNEL;
    }
    return PATIENT_CHANNEL;
  }

  private isClinician(participant: RoomParticipant, present: RoomParticipant[]): boolean {
    const matches = (p: RoomParticipant) => this.clinicianPattern !== null && p.externalId !== null && this.clinicianPattern.test(p.externalId);
    if (matches(participant)) return true;
    return HOST_ROLES.has(participant.roleName) && !present.some(matches);
  }
}
