import type { LogFields, Logger } from "../../src/logger.js";

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  fields: LogFields | undefined;
}

export function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const logger = {
    entries,
    debug: (message: string, fields?: LogFields) => entries.push({ level: "debug", message, fields }),
    info: (message: string, fields?: LogFields) => entries.push({ level: "info", message, fields }),
    warn: (message: string, fields?: LogFields) => entries.push({ level: "warn", message, fields }),
    error: (message: string, fields?: LogFields) => entries.push({ level: "error", message, fields }),
    child: () => logger,
  };
  return logger;
}
