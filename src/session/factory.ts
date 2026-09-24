import type { CortiClient } from "@corti/sdk";
import type { Config } from "../config.js";
import { Scribe } from "../corti/scribe.js";
import type { Logger } from "../logger.js";
import type { OutputSink } from "../output/sink.js";
import { CHANNEL_ROLES } from "./channel-map.js";
import { Session } from "./session.js";
import { WherebyRoom } from "./whereby-room.js";

/** Builds a production session for a room: Whereby room, Corti scribe, configured timings. */
export function createSession({
  roomUrl,
  config,
  client,
  sink,
  logger,
  audioTap,
}: {
  roomUrl: string;
  config: Config;
  client: CortiClient;
  sink: OutputSink;
  logger: Logger;
  audioTap?: (chunk: Buffer) => void;
}): Session {
  const room = new WherebyRoom({ roomUrl, assistantKey: config.whereby.assistantKey, logger });
  const scribe = new Scribe({
    client,
    channelRoles: CHANNEL_ROLES,
    language: config.corti.primaryLanguage,
    retentionPolicy: config.corti.retentionPolicy,
    templateKey: config.corti.noteTemplateKey,
    logger,
  });
  return new Session({
    room,
    scribe,
    sink,
    clinicianPattern: config.clinicianExternalIdPattern,
    endGraceMs: config.endGraceSeconds * 1000,
    logger,
    ...(audioTap ? { audioTap } : {}),
  });
}
