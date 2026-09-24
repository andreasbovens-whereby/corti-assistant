import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DRAFT_LABEL, type DraftNote, type TranscriptSegment } from "../../src/corti/types.js";
import { MemorySink, type MemorySinkEvent } from "../../src/output/memory-sink.js";
import { CompositeSink, type OutputSink } from "../../src/output/sink.js";
import { WebhookSink } from "../../src/output/webhook-sink.js";
import { recordingLogger } from "../helpers/recording-logger.js";

const segment = (id: string, text: string, final = true): TranscriptSegment => ({ id, channel: 0, role: "doctor", text, final, start: 0, end: 1 });
const note: DraftNote = {
  status: "draft",
  label: DRAFT_LABEL,
  interactionId: "i",
  documentId: "d",
  templateKey: "corti-soap",
  language: "en",
  basedOn: "facts",
  sections: [{ key: "plan", heading: "Plan", text: "Rest." }],
  generatedAt: "2026-09-24T10:00:00.000Z",
};

describe("MemorySink", () => {
  it("keeps the current state per session and emits every update", () => {
    const sink = new MemorySink();
    const events: MemorySinkEvent["type"][] = [];
    sink.on("update", (e) => events.push(e.type));
    sink.onSession({ sessionId: "s", roomUrl: "https://x.whereby.com/r", state: "live" });
    sink.onTranscript("s", segment("1", "Hel", false));
    sink.onTranscript("s", segment("1", "Hello")); // final replaces interim
    sink.onTranscript("s", segment("2", "How are you?"));
    sink.onFacts("s", [{ id: "f", text: "Fact", group: "g", source: "core" }]);
    sink.onNote("s", note);
    sink.onError("s", "something");

    const record = sink.get("s")!;
    expect(record.transcript.map((t) => t.text)).toEqual(["Hello", "How are you?"]);
    expect(record.facts).toHaveLength(1);
    expect(record.note?.label).toBe(DRAFT_LABEL);
    expect(record.errors).toEqual(["something"]);
    expect(events).toEqual(["session", "transcript", "transcript", "transcript", "facts", "note", "error"]);
  });

  it("keeps only the most recent sessions", () => {
    const sink = new MemorySink(2);
    for (const id of ["a", "b", "c"]) sink.onSession({ sessionId: id, roomUrl: "", state: "live" });
    expect(sink.list().map((r) => r.info.sessionId)).toEqual(["b", "c"]);
  });
});

describe("WebhookSink", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  async function receiver(status = 200) {
    const received: { type: string; sessionId: string; data: unknown }[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`);
    return { received, url };
  }

  it("POSTs each event as JSON", async () => {
    const { received, url } = await receiver();
    const sink = new WebhookSink(url);
    await sink.onTranscript("s", segment("1", "Hello"));
    await sink.onNote("s", note);
    expect(received.map((r) => r.type)).toEqual(["transcript", "note"]);
    expect(received[1]).toMatchObject({ sessionId: "s", data: { status: "draft", label: DRAFT_LABEL } });
  });

  it("logs failures instead of throwing", async () => {
    const { url } = await receiver(500);
    const logger = recordingLogger();
    await expect(new WebhookSink(url, logger).onError("s", "x")).resolves.toBeUndefined();
    await expect(new WebhookSink(new URL("http://127.0.0.1:1/"), logger, 500).onError("s", "x")).resolves.toBeUndefined();
    expect(logger.entries.map((e) => e.message)).toEqual(["Output webhook rejected an event", "Output webhook failed"]);
  });
});

describe("CompositeSink", () => {
  it("delivers to every sink even if one fails", async () => {
    const memory = new MemorySink();
    const failing: OutputSink = {
      onSession: () => {
        throw new Error("boom");
      },
      onTranscript: async () => {
        throw new Error("boom");
      },
      onFacts: () => {},
      onNote: () => {},
      onError: () => {},
    };
    const sink = new CompositeSink(failing, memory);
    await sink.onSession({ sessionId: "s", roomUrl: "", state: "live" });
    await sink.onTranscript("s", segment("1", "Hi"));
    expect(memory.get("s")?.transcript).toHaveLength(1);
  });
});
