import { afterEach, describe, expect, it } from "vitest";
import { createCortiClient } from "../../src/corti/client.js";
import { Scribe } from "../../src/corti/scribe.js";
import { DRAFT_LABEL } from "../../src/corti/types.js";
import { MemorySink } from "../../src/output/memory-sink.js";
import type { OutputSink } from "../../src/output/sink.js";
import { CHANNEL_ROLES } from "../../src/session/channel-map.js";
import { Session } from "../../src/session/session.js";
import { FakeCorti, fakeCortiCredentials, type FakeCortiOptions, type StreamConnection } from "../helpers/fake-corti.js";
import { FakeRoom } from "../helpers/fake-room.js";
import { recordingLogger } from "../helpers/recording-logger.js";
import { deinterleave, rms, toneAmplitude } from "../helpers/signals.js";

const DOCTOR_HZ = 440;
const PATIENT_HZ = 1000;
const RELATIVE_HZ = 2500;

let fake: FakeCorti | undefined;
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.end("test cleanup")));
  await fake?.stop();
  fake = undefined;
});

/**
 * A pretend speech recogniser: for every chunk, each channel with audio on it gets a
 * transcript segment naming the dominant tone. That makes speaker attribution visible
 * end to end: a doctor tone must come back as a doctor segment.
 */
function fakeRecogniser(connection: StreamConnection, index: number): void {
  const channels = deinterleave(connection.chunks[index]!.data, 2);
  channels.forEach((samples, channel) => {
    if (rms(samples) < 500) return;
    const tones = [DOCTOR_HZ, PATIENT_HZ, RELATIVE_HZ].filter((hz) => toneAmplitude(samples, hz, 16_000) > 2000);
    if (tones.length === 0) return; // someone started or stopped mid-chunk: too little to recognise
    connection.send({
      type: "transcript",
      data: [{ id: `c${index}-${channel}`, transcript: `tones ${tones.join("+")}`, final: true, speakerId: -1, participant: { channel }, time: { start: index * 0.25, end: (index + 1) * 0.25 } }],
    });
  });
  if (index === 3) {
    connection.send({ type: "facts", fact: [{ id: "f1", text: "Headache for two days", group: "history-of-present-illness", groupId: "g", isDiscarded: false, source: "core", createdAt: "" }] });
  }
}

async function setup({ fakeOptions = {}, sink = new MemorySink(), endGraceMs = 300, noShowTimeoutMs }: { fakeOptions?: FakeCortiOptions; sink?: OutputSink; endGraceMs?: number; noShowTimeoutMs?: number } = {}) {
  fake = await FakeCorti.start(fakeOptions);
  fake.onChunk = fakeRecogniser;
  const client = createCortiClient(
    { ...fakeCortiCredentials, region: "eu", primaryLanguage: "en", noteTemplateKey: "corti-soap", retentionPolicy: "none" },
    fake.urls,
  );
  const logger = recordingLogger();
  const scribe = new Scribe({
    client,
    channelRoles: CHANNEL_ROLES,
    language: "en",
    retentionPolicy: "none",
    templateKey: "corti-soap",
    logger,
    configTimeoutMs: 2000,
    endTimeoutMs: 2000,
    reconnectDelayMs: { initial: 50, max: 200 },
  });
  const room = new FakeRoom();
  const session = new Session({ room, scribe, sink, clinicianPattern: /^clinician:/, endGraceMs, noShowTimeoutMs, logger });
  sessions.push(session);
  return { fake, room, scribe, session, sink, logger };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (condition: () => boolean, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
};

describe("Session end to end (fake room, fake Corti, real SDK)", () => {
  it("scribes a consultation: attributed transcript, facts, draft note, clean shutdown", async () => {
    const { fake, room, session, sink } = await setup();
    const states: string[] = [];
    (sink as MemorySink).on("update", (e) => e.type === "session" && states.push(e.info.state));
    const doctor = room.add({ id: "d", roleName: "host", externalId: "clinician:42" }, DOCTOR_HZ);
    const patient = room.add({ id: "p", roleName: "visitor", externalId: "patient:7" }, PATIENT_HZ);

    await session.start();
    expect(session.state).toBe("live");

    doctor.talking = true; // the doctor speaks...
    await sleep(1000);
    doctor.talking = false;
    patient.talking = true; // ...then the patient answers
    await sleep(1000);
    patient.talking = false;

    room.remove("p");
    room.remove("d"); // everyone leaves: the grace period starts
    await session.finished;

    const record = (sink as MemorySink).get(session.id)!;
    // Transcript: the doctor's tone is attributed to the doctor, the patient's to the patient.
    const byRole = (role: string) => record.transcript.filter((s) => s.role === role).map((s) => s.text);
    expect(byRole("doctor").length).toBeGreaterThanOrEqual(2);
    expect(byRole("patient").length).toBeGreaterThanOrEqual(2);
    expect(new Set(byRole("doctor"))).toEqual(new Set([`tones ${DOCTOR_HZ}`]));
    expect(new Set(byRole("patient"))).toEqual(new Set([`tones ${PATIENT_HZ}`]));
    expect(record.transcript.every((s) => (s.role === "doctor" ? s.channel === 0 : s.channel === 1))).toBe(true);

    // Facts and the note, clearly marked as a draft.
    expect(record.facts.map((f) => f.text)).toEqual(["Headache for two days"]);
    expect(record.note).toMatchObject({ status: "draft", label: DRAFT_LABEL, basedOn: "facts", templateKey: "corti-soap" });
    expect(record.errors).toEqual([]);
    expect(states).toEqual(["starting", "live", "ending", "ended"]);

    // Corti side: one stream, well-formed 250 ms stereo chunks at real-time pace, full workflow.
    expect(fake.streams).toHaveLength(1);
    const connection = fake.streams[0]!;
    expect(connection.violations).toEqual([]);
    expect(connection.endReceived).toBe(true);
    expect(connection.chunks.every((c) => c.data.length === 16_000)).toBe(true);
    const span = connection.chunks.at(-1)!.at - connection.chunks[0]!.at;
    const expected = (connection.chunks.length - 1) * 250;
    expect(Math.abs(span - expected)).toBeLessThan(150);
    const interaction = fake.interactions.get(record.info.interactionId!)!;
    expect(interaction.statusHistory).toEqual(["planned", "in-progress", "completed"]);
    expect(interaction.encounter.identifier).toBe(session.id);

    // Whereby side: the assistant left and released every audio sink.
    expect(room.leaveCalls).toBeGreaterThanOrEqual(1);
    expect(room.stoppedTracks.sort()).toEqual(["track-d", "track-p"]);
  });

  it("mixes a third participant into the patient channel", async () => {
    const { fake, room, session, sink } = await setup();
    room.add({ id: "d", roleName: "host" }, DOCTOR_HZ);
    const patient = room.add({ id: "p" }, PATIENT_HZ);
    await session.start();
    const relative = room.add({ id: "r" }, RELATIVE_HZ); // joins mid-call
    patient.talking = true;
    relative.talking = true;
    await sleep(1000);
    await session.end("test");

    const patientSegments = (sink as MemorySink).get(session.id)!.transcript.filter((s) => s.role === "patient").map((s) => s.text);
    expect(patientSegments).toContain(`tones ${PATIENT_HZ}+${RELATIVE_HZ}`);
    expect(fake.streams[0]!.config).toMatchObject({ transcription: { participants: [{ channel: 0 }, { channel: 1 }] } });
  });

  it("keeps the call going through a Corti disconnect and still produces the note", async () => {
    const { fake, room, scribe, session, sink } = await setup();
    const doctor = room.add({ id: "d", roleName: "host" }, DOCTOR_HZ);
    room.add({ id: "p" }, PATIENT_HZ);
    await session.start();
    doctor.talking = true;
    await waitFor(() => fake.streams[0]!.chunks.length >= 4); // facts arrive at chunk 3

    fake.streams[0]!.drop();
    await waitFor(() => fake.streams.length === 2 && scribe.state === "streaming");
    expect(session.state).toBe("live");
    await waitFor(() => fake.streams[1]!.chunks.length >= 2);
    await session.end("test");

    const record = (sink as MemorySink).get(session.id)!;
    expect(record.note?.basedOn).toBe("facts");
    expect(record.errors).toContainEqual(expect.stringContaining("disconnected"));
    expect(fake.streams[1]!.violations).toEqual([]);
  });

  it("ends immediately, with a note, when the assistant is removed from the room", async () => {
    const { room, session, sink } = await setup({ endGraceMs: 60_000 });
    const doctor = room.add({ id: "d", roleName: "host" }, DOCTOR_HZ);
    await session.start();
    doctor.talking = true;
    await sleep(600);
    room.kick();
    await session.finished;
    const record = (sink as MemorySink).get(session.id)!;
    expect(record.info).toMatchObject({ state: "ended", reason: expect.stringContaining("kicked") });
    expect(record.note).toBeDefined();
  });

  it("waits out the grace period when everyone leaves, and continues if someone comes back", async () => {
    const { room, session } = await setup({ endGraceMs: 400 });
    room.add({ id: "d", roleName: "host" }, DOCTOR_HZ);
    await session.start();
    room.remove("d");
    await sleep(200);
    room.add({ id: "d2", roleName: "host" }, DOCTOR_HZ); // the doctor rejoins in time
    await sleep(400);
    expect(session.state).toBe("live");
    room.remove("d2");
    await sleep(600);
    expect(session.state).toBe("ended");
  });

  it("ends if nobody joins", async () => {
    const { session, sink } = await setup({ noShowTimeoutMs: 300 });
    await session.start();
    await session.finished;
    const record = (sink as MemorySink).get(session.id)!;
    expect(record.info).toMatchObject({ state: "ended", reason: "nobody joined" });
    // Nothing was said, so there's no note, and that's reported rather than hidden.
    expect(record.note).toBeUndefined();
    expect(record.errors).toContainEqual(expect.stringContaining("Couldn't generate the note"));
  });

  it("doesn't join the room when Corti rejects the stream", async () => {
    const { room, session, sink } = await setup({ fakeOptions: { rejectConfig: "CONFIG_DENIED" } });
    await expect(session.start()).rejects.toThrow(/CONFIG_DENIED/);
    expect(room.joined).toBe(false);
    const record = (sink as MemorySink).get(session.id)!;
    expect(record.info.state).toBe("failed");
    expect(record.errors).toContainEqual(expect.stringContaining("CONFIG_DENIED"));
  });

  it("cancels the Corti interaction when joining the room fails", async () => {
    const { fake, room, session, sink } = await setup();
    room.failJoin = new Error("room is locked");
    await expect(session.start()).rejects.toThrow("room is locked");
    const record = (sink as MemorySink).get(session.id)!;
    expect(record.info.state).toBe("failed");
    const [interaction] = fake.interactions.values();
    expect(interaction!.statusHistory).toEqual(["planned", "in-progress", "cancelled"]);
  });

  it("reports a failed note but still completes the interaction", async () => {
    const { fake, room, session, sink } = await setup({ fakeOptions: { failDocuments: 500 } });
    const doctor = room.add({ id: "d", roleName: "host" }, DOCTOR_HZ);
    await session.start();
    doctor.talking = true;
    await sleep(1200);
    await session.end("test");
    const record = (sink as MemorySink).get(session.id)!;
    expect(record.note).toBeUndefined();
    expect(record.errors).toContainEqual(expect.stringContaining("Couldn't generate the note"));
    expect(fake.interactions.get(record.info.interactionId!)!.statusHistory.at(-1)).toBe("completed");
  });

  it("survives a sink that throws", async () => {
    const broken: OutputSink = {
      onSession: () => {},
      onTranscript: () => {
        throw new Error("sink bug");
      },
      onFacts: async () => {
        throw new Error("async sink bug");
      },
      onNote: () => {},
      onError: () => {},
    };
    const { room, session, logger } = await setup({ sink: broken });
    const doctor = room.add({ id: "d", roleName: "host" }, DOCTOR_HZ);
    await session.start();
    doctor.talking = true;
    await sleep(1200);
    await session.end("test");
    expect(session.state).toBe("ended");
    expect(logger.entries.some((e) => e.message === "Output sink failed")).toBe(true);
  });

  it("keeps transcript text and names out of the logs", async () => {
    const { room, session, logger } = await setup();
    const doctor = room.add({ id: "d", roleName: "host", displayName: "Dr. Jane Example" }, DOCTOR_HZ);
    await session.start();
    doctor.talking = true;
    await sleep(800);
    await session.end("test");
    const logs = JSON.stringify(logger.entries);
    expect(logs).not.toContain("Jane");
    expect(logs).not.toContain("tones");
    expect(logs).not.toContain("Headache");
  });
});
