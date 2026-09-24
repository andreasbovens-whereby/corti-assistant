// Server mode: webhooks start sessions automatically; the demo page shows them live.
// Usage: npm start
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { WavWriter } from "./audio/wav-writer.js";
import { ConfigError, loadConfig } from "./config.js";
import { createCortiClient } from "./corti/client.js";
import { createLogger } from "./logger.js";
import { MemorySink } from "./output/memory-sink.js";
import { CompositeSink, type OutputSink } from "./output/sink.js";
import { WebhookSink } from "./output/webhook-sink.js";
import { createApp } from "./server/app.js";
import { SessionManager } from "./server/session-manager.js";
import { CHANNEL_ROLES } from "./session/channel-map.js";
import { createSession } from "./session/factory.js";
import type { Session } from "./session/session.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

const logger = createLogger({ mode: "server" }, process.env.LOG_LEVEL === "debug" ? "debug" : "info");

// A bug in one session must not take the others down. Log and keep serving; each
// session reports its own failures to the demo page.
process.on("unhandledRejection", (reason) => logger.error("Unhandled rejection", { error: String(reason) }));
process.on("uncaughtException", (error) => logger.error("Uncaught exception", { error: error.stack ?? String(error) }));

const memory = new MemorySink();
const sinks: OutputSink[] = [memory];
if (config.outputWebhookUrl) sinks.push(new WebhookSink(config.outputWebhookUrl, logger));
const sink = new CompositeSink(...sinks);
const client = createCortiClient(config.corti);

const manager = new SessionManager({
  maxSessions: config.server.maxSessions,
  logger,
  createSession: (roomUrl) => {
    if (!process.env.DEBUG_AUDIO) return createSession({ roomUrl, config, client, sink, logger });
    // DEBUG_AUDIO=1: save what each session sends to Corti as sessions/<id>.wav (local troubleshooting only).
    let wav: WavWriter | undefined;
    const session: Session = createSession({
      roomUrl,
      config,
      client,
      sink,
      logger,
      audioTap: (chunk) => {
        if (!wav) {
          mkdirSync("sessions", { recursive: true });
          wav = new WavWriter(`sessions/${session.id}.wav`, CHANNEL_ROLES.length);
          logger.info("Saving the audio sent to Corti", { file: `sessions/${session.id}.wav` });
        }
        wav.write(chunk);
      },
    });
    void session.finished.then(() => wav?.close());
    return session;
  },
});

const generatedToken = config.server.demoToken === null;
const demoToken = config.server.demoToken ?? randomBytes(18).toString("base64url");
const server = createApp({
  manager,
  memory,
  demoToken,
  webhookSecret: config.server.webhookSecret,
  triggerRoomPattern: config.server.triggerRoomPattern,
  logger,
});

server.listen(config.port, () => {
  const base = (config.server.publicUrl?.href ?? `http://localhost:${config.port}/`).replace(/\/$/, "");
  logger.info("Server listening", { port: config.port });
  console.log(`\n  Demo page:    ${base}/#token=${demoToken}${generatedToken ? "   (random token; set DEMO_TOKEN to keep it)" : ""}`);
  console.log(`  Webhook URL:  ${base}/webhooks/whereby`);
  console.log(`  Auto-join:    ${config.server.triggerRoomPattern ? `rooms matching ${config.server.triggerRoomPattern}` : "off (set TRIGGER_ROOM_PATTERN)"}\n`);
  if (!config.server.webhookSecret) logger.warn("WHEREBY_WEBHOOK_SECRET isn't set: webhooks are accepted without checking their signature");
});
server.on("error", (error) => {
  logger.error("Server failed", { error: String(error) });
  process.exit(1);
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) process.exit(130); // second signal: quit now
  stopping = true;
  logger.info("Shutting down; ending open sessions (signal again to quit immediately)", { signal });
  server.close();
  await manager.shutdown();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
