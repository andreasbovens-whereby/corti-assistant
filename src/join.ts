// Manual mode: scribe one room without webhooks.
// Usage: npm run join -- <roomUrl>
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { WavWriter } from "./audio/wav-writer.js";
import { ConfigError, loadConfig } from "./config.js";
import { createCortiClient } from "./corti/client.js";
import { createLogger } from "./logger.js";
import { ConsoleSink } from "./output/console-sink.js";
import { MemorySink } from "./output/memory-sink.js";
import { CompositeSink, type OutputSink } from "./output/sink.js";
import { WebhookSink } from "./output/webhook-sink.js";
import { CHANNEL_ROLES } from "./session/channel-map.js";
import { createSession } from "./session/factory.js";

const roomUrl = process.argv[2];
if (!roomUrl || !/^https:\/\/[^/]+\.whereby\.com\/./.test(roomUrl)) {
  console.error("Usage: npm run join -- https://<subdomain>.whereby.com/<room>");
  process.exit(1);
}
// A room link can carry a host roomKey; the Assistant doesn't need it, so don't pass it on.
const cleanRoomUrl = new URL(roomUrl);
cleanRoomUrl.search = "";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error);
  process.exit(1);
}

const logger = createLogger({ mode: "manual" }, process.env.LOG_LEVEL === "debug" ? "debug" : "info");
const memory = new MemorySink();
const sinks: OutputSink[] = [memory, new ConsoleSink()];
if (config.outputWebhookUrl) sinks.push(new WebhookSink(config.outputWebhookUrl, logger));

// DEBUG_AUDIO=1 saves exactly what is sent to Corti as sessions/<id>.wav (stereo: doctor left, patient right).
mkdirSync("sessions", { recursive: true });
let wav: WavWriter | undefined;
const session = createSession({
  roomUrl: cleanRoomUrl.href,
  config,
  client: createCortiClient(config.corti),
  sink: new CompositeSink(...sinks),
  logger,
  ...(process.env.DEBUG_AUDIO ? { audioTap: (chunk: Buffer) => saveAudio(chunk) } : {}),
});
// Created on the first chunk, so a session that never went live leaves no empty file.
function saveAudio(chunk: Buffer): void {
  if (!wav) {
    wav = new WavWriter(`sessions/${session.id}.wav`, CHANNEL_ROLES.length);
    logger.info("Saving the audio sent to Corti", { file: `sessions/${session.id}.wav` });
  }
  wav.write(chunk);
}

// Resource use, to size deployments (open question in SPEC.md).
let lastCpu = process.cpuUsage();
let lastAt = performance.now();
const stats = setInterval(() => {
  const cpu = process.cpuUsage(lastCpu);
  const now = performance.now();
  const memoryUsage = process.memoryUsage();
  logger.info("Process stats", {
    cpuPercent: Number((((cpu.user + cpu.system) / 1000 / (now - lastAt)) * 100).toFixed(1)),
    rssMb: Math.round(memoryUsage.rss / 1e6),
    heapUsedMb: Math.round(memoryUsage.heapUsed / 1e6),
  });
  lastCpu = process.cpuUsage();
  lastAt = now;
}, 30_000);
stats.unref();

let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.error("\nEnding the session (Ctrl-C again to quit immediately)…");
  void session.end("interrupted");
});

try {
  await session.start();
} catch (error) {
  // Whereby doesn't let an Assistant into an empty room.
  if (String(error).includes("room_empty")) console.error("\nNobody is in the room yet. Join it first, then start the Assistant.");
  process.exit(1);
}
await session.finished;
wav?.close();

// Keep a copy of the (role-played) session for analysis; `sessions/` is git-ignored.
const record = memory.get(session.id);
if (record) {
  writeFileSync(`sessions/${session.id}.json`, JSON.stringify(record, null, 2));
  logger.info("Session saved", { file: `sessions/${session.id}.json` });
}
process.exit(0);
