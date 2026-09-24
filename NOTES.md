# Notes: SDK verification

This file checks every claim in `SPEC.md` ("What I've verified so far") against SDK **source** in `node_modules`, not against the READMEs.

| Package | Version | Files read |
|---|---|---|
| `@whereby.com/assistant-sdk` | 1.2.111 | `dist/index.cjs`, `dist/index.d.ts`, `dist/polyfills.cjs`, `dist/tools.cjs` |
| `@whereby.com/core` | 1.20.3 (transitive) | `dist/index.d.ts` (participant state, connection status, `RoomConnectionClient`) |
| `@roamhq/wrtc` | 0.9.1 (transitive) | `lib/binding.js`, native symbol table |
| `@corti/sdk` | 5.0.0 | `dist/cjs/custom/**`, `dist/cjs/api/resources/**`, `dist/cjs/api/types/**`, `dist/cjs/core/websocket/ws.js` |

Both SDKs are pinned to exact versions in `package.json`, and `test/sdk-contract.test.ts` pins the facts below that the code depends on.

Legend: ✅ confirmed · ⚠️ confirmed with a caveat · ❌ differs from the spec.

---

## Runtime: Node version

❌ **Change: target Node 24 LTS, not Node 20.**

- `@roamhq/wrtc` is an **N-API** addon. `wrtc.node` exports `napi_register_module_v1` and imports 81 `napi_*` symbols. N-API binaries are ABI-stable, so they don't depend on the Node major version. Prebuilt binaries ship as optional dependencies for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` and `win32-x64`, all glibc (no musl). This confirms the spec's "no Alpine" rule for milestone 6.
- Node 20 reached end-of-life on 2026-04-30, so a customer template shouldn't start on it.
- `vitest@5` requires `^22.12 || ^24 || >=26`, and so does `@types/node` via its peer range. On Node 20 we'd have to pin old tooling.
- I checked that wrtc loads on Node 26.3 locally. `package.json` has `engines.node >=24` and `.nvmrc` says `24`. The milestone 6 Dockerfile should use `node:24-slim` (Debian, glibc).
- npm 11 flags install scripts. Only `esbuild` (a dev dependency of vitest/tsx) has one, and it works without it. `@roamhq/wrtc` needs no install script, which is good for Docker builds.

---

## Whereby Assistant SDK

### Polyfills

⚠️ `import "@whereby.com/assistant-sdk/polyfills"` must come first. Confirmed (`dist/polyfills.cjs`). It **replaces globals process-wide**, which affects other libraries:

- `global.WebSocket = ws` (overrides Node's native `WebSocket`)
- `global.navigator` (`userAgent: "Node.js/20"`, with fake `mediaDevices`)
- `global.window = { ...global, location, screen, ... }`, but **no `window.document`**
- `global.RTCPeerConnection`, `MediaStream` and friends from wrtc

Corti's runtime detection (`core/runtime`) treats the process as a browser only if `window.document` exists. That means Corti still correctly detects Node and uses the `ws` package for its sockets. It's fragile, though: anything that later defines `window.document` would switch Corti into browser mode. The contract test asserts that it's absent.

The polyfill also exports `setWebsocketOrigin(roomUrl)`. Nothing in the SDK calls it, and it only fixes headers for Whereby's rtcstats telemetry, so we can skip it.

### Assistant

- ✅ `new Assistant({ assistantKey })`: the constructor destructures only `assistantKey`. The README's `roomUrl` constructor argument is ignored.
- ✅ `assistant.joinRoom(roomUrl)` returns `Promise<RoomJoinedSuccess>`. It can **reject** (for example, a locked room or knock rejected), so the session must handle that.
- ⚠️ **There's no `assistant.leaveRoom()`.** Use `assistant.getRoomConnection().leaveRoom()`.
- ⚠️ **An `Assistant` instance can't be reused after leaving.** The constructor subscribes to room state immediately, and on `left`/`kicked` it unsubscribes all of it. Create one `Assistant` per session.
- ✅ `ASSISTANT_JOINED_ROOM` fires on connection status `"connected"`. `ASSISTANT_LEFT_ROOM` fires on `"left"` **or `"kicked"`**. Both carry `{ roomUrl }`.
- ⚠️ `ConnectionStatus` also has `"disconnected"` and `"reconnecting"`, and neither emits an Assistant event. To log and survive network blips, subscribe with `getRoomConnection().subscribeToConnectionStatus(...)`.

### Audio tracks

- ✅ `PARTICIPANT_AUDIO_TRACK_ADDED` carries `{ participantId, trackId, data: AudioSink }`, and `PARTICIPANT_AUDIO_TRACK_REMOVED` carries `{ participantId, trackId }`.
- The SDK derives these by diffing `remoteParticipants[].stream.getTracks()` keyed by **track id**. A participant whose track is replaced (device switch, and possibly mute/unmute depending on the client) produces REMOVED then ADDED with a **new `trackId` but the same `participantId`**. Channel mapping must be keyed on the participant, not the track.
- ✅ Screenshare audio: the SDK only looks at `participant.stream`, never `presentationStream`, so screenshare audio is never surfaced. "Ignore it for now" needs no code.
- ⚠️ **`AudioSink` leaks a native sink.** The class `extends RTCAudioSink` *and* creates a second `RTCAudioSink` in `this._sink`. `subscribe()` uses the inner one, and the inherited `stop()` stops only the outer one. The SDK also never stops sinks on TRACK_REMOVED. The session has to stop both itself: `sink.stop()` plus the private `_sink.stop()`, wrapped in one helper. I'll raise this upstream.
- ✅ `AudioSink.subscribe(cb)` returns an unsubscribe function. ⚠️ It **assigns** `ondata`, so each sink has one subscriber. A second `subscribe` replaces the first.
- ✅ The frame shape is typed `{ samples: Int16Array, sampleRate, channelCount, bitsPerSample, numberOfFrames? }`. Note that `numberOfFrames` is optional. The expected 48 kHz, 10 ms, mono values can't be confirmed without a live call (milestone 4). The pipeline must read `sampleRate`/`channelCount` from each frame and not assume them. (The SDK's own mixer drops frames unless `channelCount === 1 && bitsPerSample === 16`, which suggests mono is what wrtc delivers.)

### Participant state

- ✅ `getRoomConnection().subscribeToRemoteParticipants(cb)` gives `RemoteParticipantState[]` with `id`, `displayName`, `externalId: string | null`, `roleName`, `isAudioEnabled`, `stream`, `presentationStream`, `isDialIn` and more.
- `roleName` values (from `@whereby.com/media`): `none | visitor | granted_visitor | viewer | granted_viewer | host | recorder | streamer | captioner | assistant`. Other bots (`recorder`, `assistant`, `captioner`, `streamer`) can appear as remote participants. Exclude them from channel mapping and from the "room is empty" check.

### Local media

- ✅ `startLocalMedia({ audio, video })` resolves to `{ audioSource, videoSource }` (each can be `null`). Not used here: `joinRoom` already initializes with `audio: false, video: false`.

### Trigger

- ✅ `new Trigger({ webhookTriggers, port })` (port defaults to 8080), then `trigger.start()`.
- ❌ The README spells the constant `TRIGGER_EVENT_SuCCESS`, but the export is **`TRIGGER_EVENT_SUCCESS`** (value `"trigger_event_success"`).
- ⚠️ The success event payload is `{ roomUrl, triggerWebhook }`, where `triggerWebhook` is the full webhook body.
- Supported webhook types: `assistant.requested`, `room.client.joined`, `room.client.left`, `room.session.started`, `room.session.ended`. Callbacks may return `boolean | Promise<boolean>`.
- `roomUrl` is built as `https://${data.subdomain}.whereby.com${data.roomName}`. Custom domains aren't supported.
- ⚠️ **The Trigger's server can't be extended or shut down.** `start()` creates a private `express()` app, mounts one router at `/` (`GET /` → 200, `POST /` → webhook), calls `app.listen()`, and returns `void`. The app and server are never exposed, and listen errors are only `console.error`'d. The router isn't exported either.
- ⚠️ Trigger doesn't verify webhook signatures.

**Proposal for milestone 5:** run our own small HTTP server on `PORT` for webhooks, `/healthz`, the SSE demo page and the note API. It would reproduce Trigger's ~20 lines of routing using the SDK's exported webhook types. That gives one port, proper listen errors, graceful shutdown (needed in milestone 6) and a place to verify signatures. The alternative the spec allows is Trigger on one port and the demo on a second. I'd like your call on this before milestone 5.

### Webhook payloads (answers an open question)

`room.client.joined` and `room.client.left` data **do** include the participant: `displayName`, `participantId`, `externalId`, `metadata`, `roleName`. They also include room counters: `numClients` and `numClientsByRoleName`. `room.session.started`/`ended` and `assistant.requested` carry only room fields (`meetingId`, `roomName`, `roomSessionId`, `subdomain`). The source is the SDK's type definitions; I'll confirm with real payloads in milestone 5.

---

## Corti SDK

### Client and auth

- ✅ `new CortiClient({ tenantName, environment: CortiEnvironment.Eu, auth: { clientId, clientSecret } })`.
- `environment` also accepts a region string (`"eu"`, `"us"`), which expands to `https://api.<region>.corti.app/v2`, `wss://api.<region>.corti.app/audio-bridge/v2` and so on. We pass `CORTI_ENVIRONMENT` straight through.
- ❌ **Variable names:** Corti's dashboard exports `CORTI_TENANT_NAME` and `CORTI_ENVIRONMENT`, not the spec's `CORTI_TENANT` and `CORTI_ENV`. We use the dashboard names so its block can be pasted into `.env` unchanged. The old names are rejected at startup with a rename hint, so they're never silently ignored.
- ✅ Client credentials tokens refresh automatically for REST calls, 2 minutes before expiry (`BUFFER_IN_MINUTES = 2`).

### Interaction workflow: SDK method for each step

| # | Step | SDK call | HTTP |
|---|---|---|---|
| 1 | Create interaction | `client.interactions.create({ encounter: { identifier, status: "planned", type: "first_consultation" } })` → `{ interactionId, websocketUrl }` | `POST /interactions/` |
| 2 | Post known facts (optional) | `client.facts.create(interactionId, { facts: [{ text, group, source? }] })` | `POST /interactions/{id}/facts/` |
| 3 | Set to in-progress | `client.interactions.update(interactionId, { encounter: { status: "in-progress" } })` | `PATCH /interactions/{id}` |
| 4 | Stream audio | `client.stream.connect({ id: interactionId, configuration })`, then `socket.sendAudio(buf)` | `wss …/interactions/{id}/streams` |
| 5 | End stream | `socket.sendEnd({ type: "end" })`, then wait for a `{ type: "ENDED" }` message | |
| 6 | Generate the note | `client.documents.classic.create(interactionId, { templateKey, outputLanguage, context })`, or the guided API (below) | `POST /interactions/{id}/documents/` |
| 7 | Set to completed | `client.interactions.update(interactionId, { encounter: { status: "completed" } })` | `PATCH /interactions/{id}` |

- ✅ Encounter `status` values: `planned`, `in-progress`, `on-hold`, `completed`, `cancelled`, `deleted`. `type` values: `first_consultation`, `consultation`, `emergency`, `inpatient`, `outpatient`. `title` is optional.

### Stream connection (`custom/stream/CustomStream.ts`)

- ✅ Passing `configuration` makes `connect()` send `{ type: "config", configuration }` on open and resolve after `CONFIG_ACCEPTED` (or `CONFIG_ALREADY_RECEIVED`). It rejects on `CONFIG_DENIED`, `CONFIG_MISSING`, `CONFIG_NOT_PROVIDED`, a socket error, or `ENDED`.
- ⚠️ **The docstring mentions `CONFIG_TIMEOUT`, but the stream status enum doesn't have it.** Only the `/transcribe` enum does, and the stream code doesn't handle it. If the server sends it, `connect()` won't reject on that message. Wrap `connect()` in our own timeout.
- ✅ Config is re-sent on every reconnect, through a persistent `open` listener.
- ⚠️ **The reconnect sends audio in a burst, before the config.** The underlying `ReconnectingWebSocket` queues anything sent while disconnected, with no limit (`maxEnqueuedMessages: Infinity`). On reopen it flushes that queue **before** the `open` listeners run, so the queued audio arrives before the re-sent config, all at once and faster than real time. Two rules follow:
  - Send audio with `socket.sendAudio(buf)`, which throws unless `readyState === OPEN`, not `socket.send(buf)`, which queues. Treat a closed socket as "drop this chunk" in the clock.
  - After a reconnect, hold audio until the new `CONFIG_ACCEPTED` arrives.
- ⚠️ **Reconnects reuse the original token.** The token goes into both the query string and the `Authorization` header once, at `connect()`. The internal reconnect reuses the same URL and headers. A reconnect after the token expires will fail, possibly many times (`reconnectAttempts` defaults to 30). Plan for milestone 3: set a small `reconnectAttempts`. When the SDK gives up, call `client.stream.connect()` again ourselves, which fetches a fresh token. The fake server will test both paths.
- ⚠️ `socket.on(event, cb)` **assigns** one handler per event (`message`, `open`, `close`, `error`), like the Whereby sink. The session must be the only consumer and fan out internally. `CustomStreamSocket.off(event, cb?)` exists.
- A message that fails to parse goes to the `error` handler as `"Received unknown message type"`. It's not a fatal error.

### Stream config (`StreamConfig`)

- ✅ `transcription: { primaryLanguage, isMultichannel: true, participants: [{ channel, role }] }`. `role` is one of `doctor`, `patient`, `multiple`. Also available: `diarize` (`isDiarization` is deprecated), plus top-level `keyterms`, `replacements` and `audioEvents`.
- ✅ `mode: { type: "facts" | "transcription", outputLocale?, factGenerationInterval?: "fixed" | "fast_init" }`. The default is `fixed`, roughly every 60 s.
- ✅ `audioFormat` is a free string. The docs say a mismatched or unsupported MIME type is rejected, and omitting it makes the server auto-detect the format with ffprobe. We send the exact string from the spec.
- ✅ `retentionPolicy: "none" | "retain"`. Omitting it applies the tenant default, so we always send it explicitly.

### Stream messages (server to client)

| `type` | Payload | Notes |
|---|---|---|
| `CONFIG_ACCEPTED` / `CONFIG_DENIED` / `CONFIG_MISSING` / `CONFIG_NOT_PROVIDED` / `CONFIG_ALREADY_RECEIVED` | status | |
| `transcript` | `data: [{ id, transcript, final, speakerId, participant: { channel }, time: { start, end } }]` | Speaker attribution comes from `participant.channel`. The `time` unit isn't documented in the types; measure it in milestone 4. |
| `facts` | **`fact`**: `[{ id, text, group, groupId, isDiscarded, source, createdAt, updatedAt? }]` | The key is singular: `fact`, not `facts`. Facts can arrive again as updates (same `id`) or as discarded. |
| `flushed` | | Reply to `{ type: "flush" }` |
| `delta_usage` / `usage` | `credits` | |
| `ENDED` | | Upper case. The client sends lower-case `end`. |
| `error` | `error: { id?, title?, status?, details?, doc?, requestid? }` | |
| `audio_event` | | Only when `audioEvents` is configured |

### Documents: two APIs ❌

The spec's step 6 (`POST documents with templateKey, language, …`) matches the **classic** API. The SDK also has a newer **guided** API with its own template system:

| | Classic | Guided |
|---|---|---|
| Call | `client.documents.classic.create(interactionId, req)` | `client.documents.generate(req)` |
| Template reference | `templateKey` (string key) | `templateRef: { templateId: <UUID> }` |
| Language field | `outputLanguage` (not `language`) | `outputLanguage` (BCP 47) |
| Input | `context` is **required**: `[{ type: "facts", data: [{ text, group?, source? }] }]` or transcript/string. **Multiple context objects are allowed only for transcript.** | `context` (text/transcript/facts, mixable) **or** `interactionId` (server fetches the stored facts and transcripts) |
| Listing templates | `client.templates.list({ lang? })` → `{ data: [{ key, name, status, translations[{ languageId }] }] }` | `client.documents.templates.list({ lang?, source?, published? })` → `[{ id, name, source, languages }]` |
| Response | `{ id, name, templateRef, sections[], outputLanguage, … }` (stored) | `{ document: { stringDocument, sections[{ sectionId, heading }] }, usageInfo }` (ephemeral) |

**Retention matters here.** With `retentionPolicy: "none"`, Corti doesn't store the stream's transcripts and facts. So generating from `interactionId` alone (guided) will probably find nothing to work from. We must pass the facts we collected during the stream as explicit `context`. Both APIs support that.

**Proposal for milestone 3:** use the classic API with `NOTE_TEMPLATE_KEY` and one `facts` context built from the non-discarded facts collected on the stream. It matches Corti's ambient workflow doc and the spec's config name. I'll keep the Corti client behind a small interface so switching to guided is a local change. I'd like your call if you prefer guided.

### Templates and languages (answers an open question)

`npm run list-templates [-- <lang>]` lists both kinds of template. Results for our tenant (EU) on 2026-09-24:

**Classic templates** (11, all `published`, referenced by `key`):

| Key | Name | Languages |
|---|---|---|
| `corti-soap` | SOAP Note | ar, da, de, de-CH, en, en-GB, en-US, es, fr, fr-CH, it, nl, no, pt, sv |
| `corti-h-and-p` | History and Physical | same 15 |
| `corti-patient-summary` | Patient Summary | same 15 |
| `corti-nursing-note` | Nursing Note | same 15 |
| `corti-referral` | Referral | same 15 |
| `corti-outpatient-visit-note` | Outpatient Visit Note | 14 (no fr-CH) |
| `corti-emergency-note` | Emergency Note | 14 (no fr-CH) |
| `corti-brief-clinical-note` | Brief Clinical Note | 14 (no fr-CH) |
| `corti-emergency-response-note` | Emergency Response Call Summary | 13 (no ar, fr-CH) |
| `corti-epic-avr` | Epic AVR Integration | 15 (EHR-specific) |
| `summary-of-notes` | Summary of Notes | none listed |

A classic template covers many languages under one key: you pick the language with `outputLanguage`.

**Guided templates** (177, all `source: corti`): each one is a **single language variant**, with its own UUID per language. That's 25 English templates, including SOAP Note, GP note, Outpatient Visit Note, History and Physical, Patient Summary, Referral Letter, Discharge Note, Psychology Session/Visit Note, Short/Long Psychiatry Note, Preoperative, Obstetric, Well Child Care, Cardiology Report, Lifestyle and Prevention, Detailed patient consultation, Short note and Brief Clinical Note. The other languages have smaller sets: de 23, da 22, fr 19; sv, pt, nl, it, es, ar, nb-NO and nn-NO about 11 each. The guided set is richer, especially for general practice and mental health, but switching language means switching template id.

**Decision (2026-09-24):** `NOTE_TEMPLATE_KEY=corti-soap` with the classic API. It's the standard visit note format, works when there's no physical exam, and is available in all 15 languages.

---

## Audio pipeline (milestone 2)

Code: `src/audio/`. Flow per participant: `AudioSink` frame → downmix to mono → resample to 16 kHz → channel buffer. Every 250 ms a clock takes 4000 samples from every channel, pads short channels with silence, interleaves them and hands one chunk (4000 frames × channels × 16-bit LE) to the consumer.

### Resampler (`resampler.ts`)

- A streaming **rational polyphase FIR** resampler: it handles any integer input rate, not only 48 kHz. 16 kHz input passes through untouched.
- The low-pass is a Kaiser-windowed sinc, designed from the lower Nyquist frequency: cutoff 7.5 kHz, 1 kHz transition band, 80 dB stopband. For 48 → 16 kHz that's 242 taps.
- Measured response (1 s tones at −6 dBFS):

  | Input | 1–7 kHz | 7.5 kHz | 7.9 kHz | 8 kHz | 8.5 kHz | ≥10 kHz |
  |---|---|---|---|---|---|---|
  | Output level | 0.00 dB | −6 dB | −43 dB | −81 dB | −90 dB | below 1 LSB |

  Speech energy above 7 kHz is small, and the 7–8 kHz rolloff is the unavoidable cost of 16 kHz output.
- CPU: 60 s of 48 kHz audio resamples in about 330 ms on an M-series Mac, **about 0.5% of one core per participant**. That's a first data point for the capacity question; I'll measure the whole session in milestone 4.
- State carries across calls, so 10 ms frames give bit-identical output to one long buffer (tested). The filter adds about 2.5 ms of delay.

### Clock (`clock.ts`)

- The tick schedule comes from the monotonic clock (`performance.now()`): tick *n* is due at `start + (n + 1) × 250 ms`, never at `previous tick + 250 ms`. A late timer delays one tick, not the ones after it. The test runs 60 minutes with every timer 0–40 ms late and gets exactly 14,400 ticks, each within 40 ms of its slot. A naive interval would drift by more than a minute over that hour.
- **Stalls:** if the event loop is blocked, overdue ticks are caught up immediately, as long as the lag is at most 1 s. Beyond that the clock skips to the current slot and logs a warning. This keeps Corti's "not faster than real time" rule to at most a 1 s burst.
- The clock starts only when `start()` is called, which the session will do after `CONFIG_ACCEPTED`. Audio arriving before that is buffered, but on `start()` each channel is trimmed to its newest 250 ms. That way waiting for Corti doesn't turn into permanent latency. Overflow while waiting isn't logged as a warning.

### Buffers, padding and overflow (`channel-buffer.ts`)

- A ring buffer per channel. A short read is padded with silence; this covers muted, not yet joined, left, and packet loss.
- **Overflow:** when a channel would hold more than 1 s, the oldest audio is dropped **down to 250 ms**, not down to 1 s, so a channel that overflowed returns to low latency straight away. Each drop logs a warning with the amount dropped. On a single system clock, overflow should only happen after a burst, for example when frames were delayed and then delivered together.
- **Alignment:** a tick that finds a channel short pads it, and the late frames play one tick later. So a channel's added delay rises to its worst observed jitter, rounded up to a 10 ms frame, and stays there. It doesn't keep growing. In the simulated hour (channel A 0–15 ms jitter, channel B 0–5 ms, timers 0–20 ms late), the worst skew between channels was 20 ms in minute 1 and 10 ms in each of the other 59 minutes, with no drops. The test fails if skew goes above 25 ms or gets worse over the hour. For speaker attribution, which works on the scale of words, 10–20 ms is negligible.

### Other behaviour

- **Downmix:** interleaved multichannel frames are averaged. Frames that aren't 16-bit are ignored, with one warning.
- **Channel count** is fixed per pipeline (1–8), because Corti fixes it in the stream config. How to handle a third participant is decided in the session layer (milestone 3), not here.
- **Consumer errors:** if the chunk consumer throws (for example, the socket is closed), the error is logged and the clock keeps running, so a Corti hiccup never stalls the Whereby side.
- `audioFormat(n)` builds the stream config's `audioFormat` string from the same constants the pipeline uses.

---

## Answers to open questions so far

- **Best end signal:** not settled yet. The candidates in the source:
  1. The remote participants subscription becomes empty of humans, then the grace period expires. This is in-process and always available.
  2. The `room.client.left` webhook with `numClientsByRoleName`.
  3. The `room.session.ended` webhook. It will likely not fire while the Assistant itself is still in the room, since it counts as a client. To verify in milestone 5.
  4. `ASSISTANT_LEFT_ROOM` (left or kicked).

  My plan is (1) plus (4) as the primary signals, and (2) or (3) as a fast path if the payloads bear it out.
- **Do webhooks include `externalId`/role?** Yes, for `room.client.joined` and `room.client.left` (see above).
- **Templates and languages:** 11 classic and 177 guided templates (see "Templates and languages" above).
- **Latency, CPU and memory:** to measure in milestones 4 and 5.

## Items to raise upstream

- Whereby: the `AudioSink` double sink leak; no `leaveRoom` on `Assistant`; Trigger's server not exposed and no graceful stop; the README spelling of `TRIGGER_EVENT_SUCCESS` and the constructor `roomUrl`.
- Corti: the reconnect sends queued audio before the config; reconnects reuse the stale token; `CONFIG_TIMEOUT` isn't handled by `connect()`.
