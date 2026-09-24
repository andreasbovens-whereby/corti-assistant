// Pins the SDK facts this project relies on (see NOTES.md), so an SDK upgrade
// that changes one of them fails here rather than in a live call.
import "@whereby.com/assistant-sdk/polyfills";
import * as whereby from "@whereby.com/assistant-sdk";
import { CortiClient, CortiEnvironment } from "@corti/sdk";
import { describe, expect, it } from "vitest";

describe("@whereby.com/assistant-sdk", () => {
  it("exports the event names we listen for", () => {
    expect(whereby.ASSISTANT_JOINED_ROOM).toBe("ASSISTANT_JOINED_ROOM");
    expect(whereby.ASSISTANT_LEFT_ROOM).toBe("ASSISTANT_LEFT_ROOM");
    expect(whereby.PARTICIPANT_AUDIO_TRACK_ADDED).toBe("PARTICIPANT_AUDIO_TRACK_ADDED");
    expect(whereby.PARTICIPANT_AUDIO_TRACK_REMOVED).toBe("PARTICIPANT_AUDIO_TRACK_REMOVED");
    // The README spells this TRIGGER_EVENT_SuCCESS; the real export is all caps.
    expect(whereby.TRIGGER_EVENT_SUCCESS).toBe("trigger_event_success");
  });

  it("takes only assistantKey in the constructor and has no leaveRoom of its own", () => {
    const assistant = new whereby.Assistant({ assistantKey: "test" });
    expect(typeof assistant.joinRoom).toBe("function");
    expect("leaveRoom" in assistant).toBe(false);
    expect(typeof assistant.getRoomConnection().leaveRoom).toBe("function");
  });

  it("polyfills a window without a document, so Corti still detects Node", () => {
    const g = globalThis as { window?: { document?: unknown } };
    expect(g.window).toBeDefined();
    expect(g.window?.document).toBeUndefined();
  });
});

describe("@corti/sdk", () => {
  it("resolves the EU environment URLs", async () => {
    const client = new CortiClient({
      tenantName: "tenant",
      environment: CortiEnvironment.Eu,
      auth: { clientId: "id", clientSecret: "secret" },
    });
    const urls = await client.getEnvironmentUrls();
    expect(urls.base).toBe("https://api.eu.corti.app/v2");
    expect(urls.wss).toBe("wss://api.eu.corti.app/audio-bridge/v2");
  });

  it("accepts a region string as environment", async () => {
    const client = new CortiClient({
      tenantName: "tenant",
      environment: "eu",
      auth: { clientId: "id", clientSecret: "secret" },
    });
    expect((await client.getEnvironmentUrls()).base).toBe("https://api.eu.corti.app/v2");
  });

  it("exposes the resources the ambient workflow needs", () => {
    const client = new CortiClient({
      tenantName: "tenant",
      environment: "eu",
      auth: { clientId: "id", clientSecret: "secret" },
    });
    expect(typeof client.interactions.create).toBe("function");
    expect(typeof client.interactions.update).toBe("function");
    expect(typeof client.facts.create).toBe("function");
    expect(typeof client.stream.connect).toBe("function");
    expect(typeof client.documents.classic.create).toBe("function");
    expect(typeof client.documents.generate).toBe("function");
    expect(typeof client.templates.list).toBe("function");
    expect(typeof client.documents.templates.list).toBe("function");
  });
});
