# Whereby Assistant + Corti ambient scribe

A Node.js service that joins a [Whereby Embedded](https://whereby.com/information/embedded/) video call as an Assistant and streams each participant's audio to [Corti](https://corti.ai)'s real-time ambient documentation API. The clinician and the patient go on separate channels. While the call runs, a demo page shows a live, speaker-attributed transcript and the clinical facts Corti extracts. When the call ends, the page shows a **draft clinical note**, generated from those facts for the clinician to review.

It's a reference implementation and a sales demo for telehealth platforms built on Whereby Embedded. **Use it with role-played calls only.** The demo setup (a shared token, a laptop, local logs) isn't built for real patient data.

## How it works

```
 Whereby room                     this service                                   Corti
┌──────────────┐  audio per   ┌────────────────────────────────────────┐   stereo PCM    ┌──────────────┐
│ clinician ───┼─ participant ─▶ downmix → resample to 16 kHz → buffer │  16 kHz, 250 ms  │  ambient     │
│ patient   ───┼──────────────▶ (per person)          │                ├─────────────────▶│  scribe      │
│ (+ others)   │              │   clock: every 250 ms, one chunk per   │                  │  (facts mode)│
└──────┬───────┘              │   channel, silence if someone's quiet  │◀─────────────────┤              │
       │ "invite assistant"   │                                        │ transcript, facts│              │
       └── webhook ──────────▶│  session manager · demo page (SSE)     │── note request ─▶│  documents   │
                              └────────────────────────────────────────┘                  └──────────────┘
```

- **Channels:** channel 0 is the clinician: the participant whose `externalId` matches `CLINICIAN_EXTERNAL_ID_PATTERN`, otherwise the room's host or owner. Channel 1 is the patient, and anyone else (a relative, an interpreter) is mixed into it.
- **Audio:** each person's audio is resampled on its own with an anti-aliasing filter. A clock that doesn't depend on incoming audio sends one 250 ms stereo chunk at real-time speed, so the channels stay aligned even when someone is muted or drops out.
- **Resilience:** if Corti disconnects, the service reconnects with a fresh token and the call carries on. If one call fails, the others are unaffected. Stopping the server ends open calls properly, notes included.
- **When a call ends** (the last person leaves, which makes Whereby remove the Assistant), the service ends the Corti stream, generates the note from the collected facts (or the transcript if there are none) and marks the Corti interaction completed.

[NOTES.md](NOTES.md) has the design decisions, what was verified against both SDKs' source code, and what live testing found.

## Requirements

- **Node.js 24** (`.nvmrc`), on macOS or Linux (glibc). The WebRTC library ships prebuilt binaries for those platforms.
- **A Whereby Embedded organization with Assistants enabled.** Assistants are a closed beta; see [Whereby's docs](https://docs.whereby.com/whereby-product-features/assistants).
- **A Corti API client** (client credentials) for the ambient documentation API.
- **For the demo:** a free [ngrok](https://ngrok.com) account with its free fixed domain, so Whereby can reach your laptop.

## Setup

1. **Install:**
   ```bash
   npm install
   ```
2. **Configure:** copy `.env.example` to `.env` and fill it in. The Corti variable names match Corti's dashboard, so you can paste its block. The settings are described below under "Configuration".
3. **Choose a note template:** this lists what your Corti tenant offers. The demo uses `corti-soap`.
   ```bash
   npm run list-templates
   ```
4. **Set up the Whereby dashboard:**
   - **Assistant:** create an assistant, switch it to **enabled**, and put its key in `WHEREBY_ASSISTANT_KEY`.
   - **Invites:** in the assistant's settings, set **Endpoint URL** to `https://<your-ngrok-domain>/webhooks/whereby` and turn on **Manual Invite**.
   - **Webhook:** under **Configure → Webhooks**, add the same URL and copy its signing secret into `WHEREBY_WEBHOOK_SECRET`. Whereby signs invites with that secret too, so with it set, forged requests are rejected. Which events you pick doesn't matter for invites; `room.client.joined` is only needed for automatic joining (`TRIGGER_ROOM_PATTERN`).
5. **Set up ngrok:** register your authtoken once, then put your domain in `PUBLIC_URL`.
   ```bash
   brew install ngrok
   ```
   ```bash
   ngrok config add-authtoken <your-token>
   ```

## Running the demo

Start the tunnel and the server together:
```bash
npm run demo
```

It prints the demo page link (`https://<your-domain>/#token=…`), keeps the Mac awake while it runs, and shuts everything down cleanly on Ctrl-C.

1. **Open the demo page.** The token in the link is the password; anyone with the link can watch the sessions. First-time viewers click through ngrok's free-plan warning page once.
2. **Join the room** as the clinician (host), and have the patient join as a visitor.
3. **Invite the Assistant** from inside the call, with Whereby's assistant invite button. Or paste the room URL into the demo page and click "Invite". Either way, someone must already be in the room.
4. **Talk.** Transcript lines appear 2–3 s after each sentence, and facts after a minute or two.
5. **Leave the room.** The draft note appears on the page a few seconds later.

**Tips for a good demo**
- **Two people on two devices,** or headphones with only the speaking tab unmuted. Two voices going into one microphone garble the transcript.
- **Talk for at least 3 minutes,** and have the clinician state the plan out loud ("take ibuprofen with food…"), so the note's Plan section fills in.
- **A muted participant sends no audio** until they unmute.

### Other ways to run it

- **Server without the tunnel** (webhooks need your own public URL):
  ```bash
  npm start
  ```
  On a Mac, `npm run start:laptop` does the same but keeps it awake.
- **Scribe one room directly, without webhooks.** It prints the transcript, facts and note in the terminal, and saves the session to `sessions/`. `DEBUG_AUDIO=1` also saves the exact audio sent to Corti as a WAV file; that's for troubleshooting with test calls only.
  ```bash
  npm run join -- https://<subdomain>.whereby.com/<room>
  ```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WHEREBY_ASSISTANT_KEY` | required | The assistant's key from the Whereby dashboard |
| `CORTI_TENANT_NAME`, `CORTI_CLIENT_ID`, `CORTI_CLIENT_SECRET` | required | Corti API credentials |
| `CORTI_ENVIRONMENT` | `eu` | Corti region: `eu` or `us` |
| `PRIMARY_LANGUAGE` | `en` | Spoken language, and the language of facts and note |
| `NOTE_TEMPLATE_KEY` | required | Corti (classic) template key, e.g. `corti-soap` |
| `RETENTION_POLICY` | `none` | `none`: Corti keeps no transcript or facts; `retain`: Corti's standard retention |
| `CLINICIAN_EXTERNAL_ID_PATTERN` | none | Regex on a participant's `externalId` that identifies the clinician; the host or owner is the fallback |
| `END_GRACE_SECONDS` | `30` | End the session this long after the room empties, if Whereby hasn't already removed the Assistant |
| `PORT` | `8080` | Port of the HTTP server |
| `PUBLIC_URL` | none | Public base URL (your ngrok domain); used by `npm run demo` and for printed links |
| `DEMO_TOKEN` | random | Shared token for the demo page, at least 16 characters; a random one is generated at startup if empty |
| `WHEREBY_WEBHOOK_SECRET` | none | Webhook signing secret; when set, unsigned or forged webhooks are rejected |
| `TRIGGER_ROOM_PATTERN` | none | Opt-in automatic joining: regex on room names (e.g. `^/visit-`); empty means invite only |
| `MAX_SESSIONS` | `4` | Maximum simultaneous calls (one call uses ~15% of a laptop CPU core) |
| `OUTPUT_WEBHOOK_URL` | none | Also POST every transcript, fact update and note as JSON to this URL (e.g. a customer backend) |

## HTTP endpoints

| Route | Purpose |
|---|---|
| `POST /webhooks/whereby` | Whereby webhooks and in-room invites (`assistant.requested`) |
| `GET /healthz` | Health check: `{ "status": "ok", "sessions": n }` |
| `GET /` | The demo page (static; all data comes from the API below) |
| `GET /api/sessions` | All sessions with transcript, facts, note and errors (token required) |
| `GET /api/events` | Live updates as server-sent events (token as `?token=`) |
| `POST /api/sessions` | Invite the Assistant: `{ "roomUrl": "https://…whereby.com/room" }` |
| `POST /api/sessions/:id/end` | End a session and generate its note now |

The API takes the token as `Authorization: Bearer <token>`.

## Project layout

```
src/
  audio/      resampler, per-person buffers, drift-free clock, pipeline, WAV debug writer
  corti/      Corti client, the Scribe (one interaction: stream, reconnects, note)
  session/    Whereby room adapter, channel mapping, the Session lifecycle
  output/     output sinks: in-memory (demo page), webhook, console
  server/     HTTP app, webhook verification and decisions, session manager
  server.ts   server entry point          join.ts   manual mode
public/       the demo page (plain HTML, CSS and JavaScript)
scripts/      demo launcher, template listing
test/         unit and end-to-end tests, with a fake Corti server and a fake room
```

## Development

Run the tests:
```bash
npm test
```

Typecheck, and build to `dist/`:
```bash
npm run typecheck
```
```bash
npm run build
```

The end-to-end tests run the real `@corti/sdk` against a local fake Corti server (token, interactions, documents and the audio stream) and a fake Whereby room that plays tones as "speech". No credentials are needed. The audio tests simulate a 60-minute call in virtual time.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `organization_assistant_not_enabled` | The assistant isn't enabled in the Whereby dashboard, or the org doesn't have Assistants |
| `room_empty` | Whereby doesn't let an Assistant into an empty room: join first, then invite |
| A participant's channel stays silent | Their mic is muted; the audio track appears when they unmute |
| Garbled transcript | Two voices into one microphone (two tabs on one laptop): use headphones, one unmuted tab, or two devices |
| The demo says the ngrok tunnel "isn't authenticated" or "is already running" | Run `ngrok config add-authtoken …`, or stop the other ngrok |
| Invites are ignored with "invalid signature" | `WHEREBY_WEBHOOK_SECRET` doesn't match the webhook's secret in the dashboard |
| The note's Plan section is empty | The plan wasn't said out loud; facts only capture what was discussed |

## Security and privacy

- **Role-played data only.** Don't use this demo setup with real patients.
- **Nothing goes into the Whereby chat.** Transcripts, facts and notes never appear in the room, where the patient would see them.
- **Every note is marked** "DRAFT: generated by AI, for clinician review".
- **Logs contain ids, roles and counts only:** no names, transcript text, facts or notes.
- **The in-memory session store keeps the 50 most recent sessions** and is cleared when the server restarts.
- **`RETENTION_POLICY=none`** tells Corti not to keep the stream's transcript and facts. The generated note is stored by Corti, like any classic document.
