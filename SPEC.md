# Spec: Whereby Assistant + Corti ambient scribe (version 2)

## Goal

Build a Node.js service that joins Whereby rooms as an Assistant, streams each participant's audio to Corti's real-time ambient documentation API (clinician and patient on separate channels), shows live transcript and facts on a demo page, and produces a draft clinical note when the call ends.

This is a reference implementation and sales demo for telehealth platforms built on Whereby Embedded. Code quality matters: customers may read it as a template.

## How to work

- Before writing code, install both SDKs and read their **source** in `node_modules` (not just the READMEs, which have known inaccuracies). Confirm every API named in this spec. If something differs, follow the source and note it in `NOTES.md`.
- Work milestone by milestone (below). Commit after each one. Stop and check with me before moving to the next milestone.
- Ask me for credentials when you need them. Never commit secrets.
- Use TypeScript, Node 20 LTS (check which versions `@roamhq/wrtc` ships prebuilt binaries for), and `vitest` for tests.

## Stack

- `@whereby.com/assistant-sdk` (source: https://github.com/whereby/sdk/tree/main/packages/assistant-sdk)
- `@corti/sdk` (source: https://github.com/corticph/corti-sdk-javascript)
- No FFmpeg. We use per-participant audio sinks, not the SDK's combined audio stream (which requires FFmpeg).

## What I've verified so far (confirm against source)

### Whereby Assistant SDK

- Import `@whereby.com/assistant-sdk/polyfills` first; it's required in Node.
- `new Assistant({ assistantKey })`, then `assistant.joinRoom(roomUrl)`. The README passes `roomUrl` to the constructor, but the constructor source only takes `assistantKey`.
- The `PARTICIPANT_AUDIO_TRACK_ADDED` event carries `{ participantId, trackId, data: AudioSink }`. There's a matching `PARTICIPANT_AUDIO_TRACK_REMOVED` event.
- `AudioSink.subscribe(cb)` delivers `{ samples: Int16Array, sampleRate, channelCount, bitsPerSample, numberOfFrames }`. Expect 48 kHz, roughly 10 ms frames. `subscribe` returns an unsubscribe function.
- There are also `ASSISTANT_JOINED_ROOM` and `ASSISTANT_LEFT_ROOM` events.
- Participant state (via `assistant.getRoomConnection().subscribeToRemoteParticipants(...)`) includes `displayName`, `roleName` and `externalId`.
- The Trigger API is `new Trigger({ webhookTriggers: { "room.client.joined": (payload) => boolean }, port })`, with `trigger.start()`, emitting a success event with `{ roomUrl }`. The README spells the constant `TRIGGER_EVENT_SuCCESS`; check the real export name.
- `startLocalMedia({ audio, video })` returns an `AudioSource` and a `VideoSource` (the Assistant can publish media). Not needed for this project.

### Corti SDK

- The client is `new CortiClient({ tenantName, environment: CortiEnvironment.Eu, auth: { clientId, clientSecret } })`. Client credentials tokens are refreshed automatically.
- Create an interaction with `client.interactions.create({ encounter: { identifier, status: "planned", type: "first_consultation" } })`.
- Stream connection: see `src/custom/stream/CustomStream.ts`. Passing `configuration` to `connect()` makes it resolve after `CONFIG_ACCEPTED`, and config is re-sent automatically on reconnect. Audio is sent as binary via `socket.send(...)`.
- Stream config (`StreamConfig`):
  - `transcription`: `{ primaryLanguage, isMultichannel: true, participants: [{ channel: 0, role: "doctor" }, { channel: 1, role: "patient" }] }`
  - `mode`: `{ type: "facts", outputLocale, factGenerationInterval: "fast_init" }`
  - `audioFormat`: `"audio/pcm; rate=16000; channels=2; bits=16; endian=little; encoding=sint"`
  - `retentionPolicy`: configurable, with `"none"` as the default for the demo
- Corti's audio guidance (https://docs.corti.ai/stt/audio):
  - 16 kHz, 16-bit little-endian PCM
  - chunks of about 250 ms (much smaller chunks hurt accuracy)
  - stream at real-time speed, not faster
  - keep all channels aligned in time
  - one speaker per channel
  - up to 8 channels
- Workflow (https://docs.corti.ai/workflows/ambient-rt):
  1. Create the interaction.
  2. Optionally post known facts.
  3. PATCH the interaction to `in-progress`.
  4. Stream audio.
  5. Send an `end` message and wait for `ended`.
  6. POST documents with `templateKey`, `language`, and the facts and/or transcript.
  7. PATCH the interaction to `completed`.

  Find the SDK methods for each step, and list the available templates.

## Architecture

One Node process, containing:

1. **Trigger listener.** It receives Whereby webhooks and starts one session per room. Guard against duplicates: `room.client.joined` fires for every participant who joins.
2. **Session manager.** A map from room URL to session. It cleans up on end and tolerates crashes in one session without taking down others.
3. **Session:** Assistant, audio pipeline, Corti stream, output sink.
4. **Demo page.** Server-sent events showing live transcript, live facts, and the final draft note for each session. Plain HTML/JS, no framework. If the Trigger's server can't be extended with extra routes, run the demo on a second port and document it.
5. **Manual mode.** `npm run join -- <roomUrl>` starts a session without webhooks, for local testing.

### Audio pipeline (the core piece; test it thoroughly)

1. **Per participant:** take the `AudioSink` frames and downmix to mono if `channelCount > 1`. Resample 48 kHz to 16 kHz with a proper anti-aliasing low-pass filter; naive every-third-sample decimation is not acceptable. Append the result to that participant's buffer.
2. **Clock-driven interleaver:** a timer ticks every 250 ms, independent of incoming audio. On each tick, it:
   - takes 4000 samples per channel from each channel's buffer;
   - pads with silence when a buffer is short (muted, packet loss, not yet joined);
   - interleaves the channels into one stereo chunk and sends it to Corti.
3. **Drift control:** if a buffer grows beyond about 1 s, drop the oldest audio and log a warning. Use a monotonic clock, and correct for timer drift so the stream stays at real-time speed over a 60-minute call.
4. Start the clock only after Corti confirms the configuration.

### Role and channel mapping

- **Channel 0 (doctor):** the participant whose `externalId` matches a configurable clinician pattern. If none matches, fall back to `roleName === "host"`.
- **Channel 1 (patient):** the first other participant.
- **Extra participants:** assign channels 2 to 7 with role `"multiple"`. Corti needs the channel count fixed up front, so decide how to handle a third person joining mid-call (options: pre-allocate channels, or mix extras into the patient channel). Document the choice.
- **Rejoins:** a participant who leaves and rejoins keeps their channel.
- **Screenshare audio:** ignore it for now.

### Session lifecycle

- **Start:** a trigger fires (or manual mode). Create the Corti interaction (identifier = room name plus timestamp), connect the stream, join the room, then start the clock.
- **End:** when no remote participants remain for a configurable grace period (default 30 s), or when the Assistant leaves the room. Investigate whether a better end signal exists (a webhook or room event).
- **After end:** send `end` to Corti, wait for final updates, generate the note from the configured template, PATCH to `completed`, and push the note to the output sink. Then leave the room.
- **Failures:** if Corti fails mid-call, log it, try to reconnect (the SDK re-sends the config), and keep the Whereby session alive.

### Output sink

Define a small interface, for example `onTranscript`, `onFacts`, `onNote`, `onError`. The default implementation feeds the demo page from memory. A second, optional implementation POSTs to a configurable webhook URL (standing in for the customer's backend).

Rules for the output:

- Never post transcript, facts or notes into the Whereby room chat. It's visible to the patient.
- Label the note as a draft for clinician review.

## Configuration (.env)

`WHEREBY_ASSISTANT_KEY`, `CORTI_TENANT`, `CORTI_CLIENT_ID`, `CORTI_CLIENT_SECRET`, `CORTI_ENV` (default `eu`), `PRIMARY_LANGUAGE` (default `en`), `NOTE_TEMPLATE_KEY`, `RETENTION_POLICY` (default `none`), `CLINICIAN_EXTERNAL_ID_PATTERN`, `END_GRACE_SECONDS`, `PORT`, `OUTPUT_WEBHOOK_URL` (optional).

Provide `.env.example`, validate the config at startup, and fail fast with clear messages.

## Milestones

1. **Scaffold and SDK verification.** Set up the project, install both SDKs, and write `NOTES.md` confirming or correcting each API in "What I've verified so far".
   - *Done when:* `NOTES.md` is written and the project builds.
2. **Audio pipeline, no network.** Build the resampler, per-participant buffers, interleaver and drift control.
   - *Done when:* unit tests use synthetic sine waves at different frequencies per participant, and prove:
     - correct resampling (frequency preserved, no aliasing of a tone above 8 kHz);
     - 250 ms stereo chunks;
     - silence padding when one side stops;
     - alignment maintained over a simulated 60-minute run;
     - buffer drop on overflow.
3. **Corti integration against a fake server.** Build a local fake WebSocket server that mimics config accept/reject, transcript and facts messages, and `end`/`ended`.
   - *Done when:* the full session flow runs end-to-end in tests with no real credentials.
4. **Manual mode, live.** Use a real Whereby test room and real Corti credentials (I'll provide them). Two people join and hold a role-played consultation.
   - *Done when:* transcripts are attributed to the correct speaker, facts appear, and a note is generated.
5. **Triggers and demo page.** Wire up webhooks via ngrok or Cloudflare Tunnel, add the session manager and the SSE demo page.
   - *Done when:* joining a room automatically starts the Assistant, and the demo page shows everything live.
6. **Deployment.**
   - Dockerfile on `node:20-slim` or similar. Use glibc, not Alpine, since `@roamhq/wrtc` ships prebuilt glibc binaries. No FFmpeg.
   - `fly.toml` for region `fra`, with secrets via `fly secrets`, a health check endpoint, and graceful shutdown that ends open sessions cleanly.
   - *Done when:* it's deployed and working with the webhook pointed at Fly.

## Non-goals

- The SDK's combined audio stream, and FFmpeg.
- The Assistant speaking or publishing any media.
- EHR integration.
- Authentication on the demo page beyond a simple shared token (add that token).
- Real patient data. Use only role-played test calls.

## Open questions to answer along the way

- What's the best signal that a session has ended?
- Do Whereby webhook payloads include participant `externalId`/role, or only the room?
- Which Corti note templates exist, and which languages do they support?
- What's the actual latency from speech to transcript to demo page?
- How much CPU and memory does one session use? This decides how many concurrent sessions a small Fly instance can handle.
