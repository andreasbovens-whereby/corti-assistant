export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Writes one JSON object per line: easy to read locally and to ingest on Fly. */
export function createLogger(base: LogFields = {}, minLevel: Level = "info"): Logger {
  const log = (level: Level, message: string, fields?: LogFields) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...base, ...fields });
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, minLevel),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
