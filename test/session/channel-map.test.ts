import { describe, expect, it } from "vitest";
import { ChannelMap, DOCTOR_CHANNEL, PATIENT_CHANNEL } from "../../src/session/channel-map.js";
import type { RoomParticipant } from "../../src/session/room.js";

const person = (id: string, roleName = "visitor", externalId: string | null = null): RoomParticipant => ({
  id,
  displayName: id,
  roleName,
  externalId,
});

describe("ChannelMap", () => {
  it("puts the participant matching the clinician pattern on the doctor channel", () => {
    const map = new ChannelMap(/^clinician:/);
    const patient = person("p", "host", "patient:7"); // even a host doesn't win over a match
    const doctor = person("d", "visitor", "clinician:42");
    const present = [patient, doctor];
    expect(map.channelFor(patient, present)).toBe(PATIENT_CHANNEL);
    expect(map.channelFor(doctor, present)).toBe(DOCTOR_CHANNEL);
  });

  it("falls back to the host when nobody matches the pattern", () => {
    const map = new ChannelMap(/^clinician:/);
    const host = person("h", "host");
    const guest = person("g");
    expect(map.channelFor(guest, [guest, host])).toBe(PATIENT_CHANNEL);
    expect(map.channelFor(host, [guest, host])).toBe(DOCTOR_CHANNEL);
  });

  it("falls back to the host when no pattern is configured", () => {
    const map = new ChannelMap(null);
    const host = person("h", "host", "clinician:1");
    expect(map.channelFor(host, [host])).toBe(DOCTOR_CHANNEL);
  });

  it("mixes everyone else into the patient channel", () => {
    const map = new ChannelMap(null);
    const people = [person("h", "host"), person("p"), person("relative"), person("interpreter")];
    expect(people.map((p) => map.channelFor(p, people))).toEqual([0, 1, 1, 1]);
  });

  it("gives the doctor channel to only one person at a time", () => {
    const map = new ChannelMap(null);
    const first = person("h1", "host");
    const second = person("h2", "host");
    expect(map.channelFor(first, [first])).toBe(DOCTOR_CHANNEL);
    expect(map.channelFor(second, [first, second])).toBe(PATIENT_CHANNEL);
    // The same track asking again keeps its channel.
    expect(map.channelFor(first, [first, second])).toBe(DOCTOR_CHANNEL);
  });

  it("gives the doctor channel back to a clinician who rejoins", () => {
    const map = new ChannelMap(/^clinician:/);
    const before = person("d-1", "visitor", "clinician:42");
    const patient = person("p");
    expect(map.channelFor(before, [before, patient])).toBe(DOCTOR_CHANNEL);
    // Rejoining gives a new participant id; the old one is gone.
    const after = person("d-2", "visitor", "clinician:42");
    expect(map.channelFor(after, [patient, after])).toBe(DOCTOR_CHANNEL);
    // The patient keeps theirs across a rejoin too.
    const patientAgain = person("p-2");
    expect(map.channelFor(patientAgain, [after, patientAgain])).toBe(PATIENT_CHANNEL);
  });

  it("puts everyone on the patient channel when no clinician can be identified", () => {
    const map = new ChannelMap(/^clinician:/);
    const people = [person("a"), person("b")];
    expect(people.map((p) => map.channelFor(p, people))).toEqual([1, 1]);
  });
});
