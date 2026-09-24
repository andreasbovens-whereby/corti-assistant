import { afterEach, describe, expect, it } from "vitest";
import { createCortiClient } from "../../src/corti/client.js";
import { Scribe, type ScribeOptions } from "../../src/corti/scribe.js";
import { DRAFT_LABEL, type Fact } from "../../src/corti/types.js";
import { FakeCorti, fakeCortiCredentials, type FakeCortiOptions, type StreamConnection } from "../helpers/fake-corti.js";

let fake: FakeCorti | undefined;
const scribes: Scribe[] = [];
afterEach(async () => {
  // Stop every scribe first: a live one would keep reconnecting to the stopped server.
  await Promise.all(scribes.splice(0).map((s) => s.cancel()));
  await fake?.stop();
  fake = undefined;
});

async function setup(fakeOptions: FakeCortiOptions = {}, scribeOptions: Partial<ScribeOptions> = {}) {
  fake = await FakeCorti.start(fakeOptions);
  const client = createCortiClient(
    { ...fakeCortiCredentials, region: "eu", primaryLanguage: "en", noteTemplateKey: "corti-soap", retentionPolicy: "none" },
    fake.urls,
  );
  const scribe = new Scribe({
    client,
    channelRoles: ["doctor", "patient"],
    language: "en",
    retentionPolicy: "none",
    templateKey: "corti-soap",
    configTimeoutMs: 2000,
    endTimeoutMs: 1000,
    reconnectDelayMs: { initial: 50, max: 200 },
    ...scribeOptions,
  });
  scribes.push(scribe);
  const states: string[] = [];
  scribe.on("state", (s) => states.push(s));
  return { fake, scribe, states };
}

const chunk = () => Buffer.alloc(16_000);
const waitFor = async (condition: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const stream = (index = 0): StreamConnection => fake!.streams[index]!;

describe("Scribe against a fake Corti", () => {
  it("creates the interaction, marks it in progress and connects with the expected config", async () => {
    const { fake, scribe, states } = await setup();
    await scribe.start("visit-42-20260924T101500Z");

    const interaction = fake.interactions.get(scribe.interactionId!)!;
    expect(interaction.encounter).toMatchObject({ identifier: "visit-42-20260924T101500Z", type: "first_consultation" });
    expect(interaction.statusHistory).toEqual(["planned", "in-progress"]);
    expect(stream().config).toEqual({
      transcription: {
        primaryLanguage: "en",
        isMultichannel: true,
        participants: [
          { channel: 0, role: "doctor" },
          { channel: 1, role: "patient" },
        ],
      },
      mode: { type: "facts", outputLocale: "en", factGenerationInterval: "fast_init" },
      audioFormat: "audio/pcm; rate=16000; channels=2; bits=16; endian=little; encoding=sint",
      retentionPolicy: "none",
    });
    expect(states).toEqual(["connecting", "streaming"]);

    expect(scribe.sendAudio(chunk())).toBe(true);
    await waitFor(() => stream().chunks.length === 1);
    expect(stream().violations).toEqual([]);
  });

  it("fails to start when Corti denies the config", async () => {
    const { scribe } = await setup({ rejectConfig: "CONFIG_DENIED" });
    await expect(scribe.start("visit")).rejects.toThrow(/CONFIG_DENIED/);
    expect(scribe.state).toBe("failed");
    expect(scribe.sendAudio(chunk())).toBe(false);
  });

  it("fails to start when Corti never answers the config", async () => {
    const { scribe } = await setup({ ignoreConfig: true }, { configTimeoutMs: 300 });
    const started = Date.now();
    await expect(scribe.start("visit")).rejects.toThrow(/didn't accept the stream config within 300 ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("fails to start with a clear error when credentials are wrong", async () => {
    fake = await FakeCorti.start();
    const client = createCortiClient(
      { ...fakeCortiCredentials, clientSecret: "wrong", region: "eu", primaryLanguage: "en", noteTemplateKey: "x", retentionPolicy: "none" },
      fake.urls,
    );
    const scribe = new Scribe({ client, channelRoles: ["doctor", "patient"], language: "en", retentionPolicy: "none", templateKey: "x" });
    scribes.push(scribe);
    await expect(scribe.start("visit")).rejects.toThrow(/Couldn't start Corti interaction/);
  });

  it("forwards transcripts with roles, and keeps an up-to-date fact list", async () => {
    const { scribe } = await setup();
    const segments: { role: string; text: string; final: boolean }[] = [];
    const factUpdates: Fact[][] = [];
    scribe.on("transcript", (s) => segments.push({ role: s.role, text: s.text, final: s.final }));
    scribe.on("facts", (f) => factUpdates.push(f));
    await scribe.start("visit");

    const segment = (id: string, channel: number, transcript: string, final: boolean) => ({
      id, transcript, final, speakerId: -1, participant: { channel }, time: { start: 0, end: 1 },
    });
    const fact = (id: string, text: string, isDiscarded = false) => ({
      id, text, group: "history", groupId: "g1", isDiscarded, source: "core", createdAt: new Date().toISOString(),
    });
    stream().send({ type: "transcript", data: [segment("s1", 0, "What brings you in", false)] });
    stream().send({ type: "transcript", data: [segment("s1", 0, "What brings you in today?", true)] });
    stream().send({ type: "transcript", data: [segment("s2", 1, "A headache since Monday.", true)] });
    stream().send({ type: "facts", fact: [fact("f1", "Headache"), fact("f2", "Since Monday")] });
    stream().send({ type: "facts", fact: [fact("f1", "Headache, frontal"), fact("f2", "Since Monday", true)] });
    await waitFor(() => factUpdates.length === 2);

    expect(segments).toEqual([
      { role: "doctor", text: "What brings you in", final: false },
      { role: "doctor", text: "What brings you in today?", final: true },
      { role: "patient", text: "A headache since Monday.", final: true },
    ]);
    expect(scribe.transcript.map((s) => s.text)).toEqual(["What brings you in today?", "A headache since Monday."]);
    // Updated facts replace their earlier version; discarded facts disappear.
    expect(factUpdates[1]!.map((f) => f.text)).toEqual(["Headache, frontal"]);
  });

  it("ends the stream: sends end, collects final facts, waits for ENDED", async () => {
    const { fake, scribe } = await setup({ endDelayMs: 200 });
    fake.onEnd = (connection) =>
      connection.send({ type: "facts", fact: [{ id: "f9", text: "Late fact", group: "plan", groupId: "g", isDiscarded: false, source: "core", createdAt: "" }] });
    await scribe.start("visit");
    await scribe.end();

    expect(stream().endReceived).toBe(true);
    expect(scribe.currentFacts.map((f) => f.text)).toEqual(["Late fact"]);
    expect(scribe.state).toBe("ended");
    await waitFor(() => stream().closed);
    expect(scribe.sendAudio(chunk())).toBe(false);
  });

  it("doesn't hang when Corti never sends ENDED", async () => {
    const { scribe } = await setup({ ignoreEnd: true }, { endTimeoutMs: 300 });
    const warnings: string[] = [];
    scribe.on("warning", (m) => warnings.push(m));
    await scribe.start("visit");
    await scribe.end();
    expect(scribe.state).toBe("ended");
    expect(warnings).toContainEqual(expect.stringContaining("didn't confirm the end"));
  });

  it("reconnects after a dropped connection, re-sending the config before any audio", async () => {
    const { fake, scribe, states } = await setup();
    await scribe.start("visit");
    scribe.sendAudio(chunk());
    await waitFor(() => stream(0).chunks.length === 1);

    stream(0).drop();
    await waitFor(() => scribe.state === "reconnecting");
    expect(scribe.sendAudio(chunk())).toBe(false); // dropped, not queued
    await waitFor(() => scribe.state === "streaming");

    expect(fake.streams).toHaveLength(2);
    expect(stream(1).config).toEqual(stream(0).config);
    scribe.sendAudio(chunk());
    await waitFor(() => stream(1).chunks.length === 1);
    // The chunk sent while disconnected never arrives, and nothing came before the config.
    expect(stream(1).chunks).toHaveLength(1);
    expect(stream(1).violations).toEqual([]);
    expect(states).toEqual(["connecting", "streaming", "reconnecting", "streaming"]);
  });

  it("reconnects with a fresh token once the first one has expired", async () => {
    // Tokens are valid for 1.5 s on the server; the SDK refreshes them after 1 s (121 s - 120 s buffer).
    const { fake, scribe } = await setup({ tokenExpiresInSeconds: 121, tokenLifetimeMs: 1500 });
    await scribe.start("visit");
    await new Promise((r) => setTimeout(r, 1700));

    stream(0).drop();
    await waitFor(() => scribe.state === "streaming" && fake.streams.length === 2);
    expect(stream(1).token).not.toBe(stream(0).token);
    // The SDK's own reconnect (with the stale token) never happened.
    expect(fake.rejectedHandshakes).toEqual([]);
  });

  it("keeps retrying while Corti is unreachable, and stops when the session ends", async () => {
    const { fake, scribe } = await setup({}, { reconnectDelayMs: { initial: 50, max: 100 } });
    const warnings: string[] = [];
    scribe.on("warning", (m) => warnings.push(m));
    await scribe.start("visit");
    fake.options.rejectConfig = "CONFIG_DENIED"; // every reconnect attempt fails
    stream(0).drop();
    await waitFor(() => warnings.filter((w) => w.includes("reconnect failed")).length >= 3);

    await scribe.end();
    const attempts = fake.streams.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.streams.length).toBe(attempts);
    expect(scribe.state).toBe("ended");
  });


  it("survives Corti going away entirely (no unhandled rejections), and still ends cleanly", async () => {
    // Regression test: the SDK's awaitConfiguration path leaves a rejected promise
    // unhandled when a connection fails before opening, which crashes Node.
    const { fake, scribe } = await setup({}, { reconnectDelayMs: { initial: 20, max: 50 } });
    const warnings: string[] = [];
    scribe.on("warning", (m) => warnings.push(m));
    await scribe.start("visit");
    await fake.stop(); // every reconnect now gets ECONNREFUSED
    await waitFor(() => warnings.filter((w) => w.includes("reconnect failed")).length >= 5);
    expect(scribe.state).toBe("reconnecting");
    await scribe.end();
    expect(scribe.state).toBe("ended");
  });

  it("generates a draft note from the facts", async () => {
    const { fake, scribe } = await setup();
    await scribe.start("visit");
    stream().send({ type: "facts", fact: [{ id: "f1", text: "Headache", group: "history", groupId: "g", isDiscarded: false, source: "core", createdAt: "" }] });
    await waitFor(() => scribe.currentFacts.length === 1);
    await scribe.end();
    const note = await scribe.generateNote();

    const request = fake.interactions.get(scribe.interactionId!)!.documentRequests[0]!;
    expect(request).toMatchObject({
      templateKey: "corti-soap",
      outputLanguage: "en",
      context: [{ type: "facts", data: [{ text: "Headache", group: "history", source: "core" }] }],
    });
    expect(note).toMatchObject({ status: "draft", label: DRAFT_LABEL, basedOn: "facts", templateKey: "corti-soap" });
    expect(note.sections.map((s) => s.heading)).toEqual(["Subjective", "Plan"]); // sorted by `sort`
  });

  it("falls back to the transcript when there are no facts", async () => {
    const { fake, scribe } = await setup();
    await scribe.start("visit");
    stream().send({
      type: "transcript",
      data: [
        { id: "s1", transcript: "Any allergies?", final: true, speakerId: -1, participant: { channel: 0 }, time: { start: 0, end: 1 } },
        { id: "s2", transcript: "Penic", final: false, speakerId: -1, participant: { channel: 1 }, time: { start: 1, end: 2 } },
      ],
    });
    await waitFor(() => scribe.transcript.length === 1);
    await scribe.end();
    const note = await scribe.generateNote();

    expect(note.basedOn).toBe("transcript");
    expect(fake.interactions.get(scribe.interactionId!)!.documentRequests[0]!.context).toEqual([
      { type: "transcript", data: { text: "Any allergies?", channel: 0 } }, // interim segments are left out
    ]);
  });

  it("refuses to generate a note from nothing", async () => {
    const { scribe } = await setup();
    await scribe.start("visit");
    await scribe.end();
    await expect(scribe.generateNote()).rejects.toThrow(/no facts and no transcript/);
  });

  it("marks the interaction completed, or cancelled", async () => {
    const { fake, scribe } = await setup();
    await scribe.start("visit");
    await scribe.end();
    await scribe.complete();
    expect(fake.interactions.get(scribe.interactionId!)!.statusHistory.at(-1)).toBe("completed");

    const other = new Scribe({
      client: createCortiClient({ ...fakeCortiCredentials, region: "eu", primaryLanguage: "en", noteTemplateKey: "x", retentionPolicy: "none" }, fake.urls),
      channelRoles: ["doctor", "patient"], language: "en", retentionPolicy: "none", templateKey: "x",
    });
    scribes.push(other);
    await other.start("visit-2");
    await other.cancel();
    expect(fake.interactions.get(other.interactionId!)!.statusHistory.at(-1)).toBe("cancelled");
  });
});
