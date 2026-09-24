export type CortiRegion = "eu" | "us";
export type RetentionPolicy = "none" | "retain";

export interface Config {
  whereby: {
    assistantKey: string;
  };
  corti: {
    tenant: string;
    clientId: string;
    clientSecret: string;
    region: CortiRegion;
    primaryLanguage: string;
    noteTemplateKey: string;
    retentionPolicy: RetentionPolicy;
  };
  clinicianExternalIdPattern: RegExp | null;
  endGraceSeconds: number;
  port: number;
  outputWebhookUrl: URL | null;
  server: {
    /** Public base URL (e.g. the ngrok domain), used only for printing links. */
    publicUrl: URL | null;
    /** Shared token for the demo page and its API. Generated at startup if not set. */
    demoToken: string | null;
    /** Secret for verifying `Whereby-Signature` on incoming webhooks. */
    webhookSecret: string | null;
    /** Rooms (by room name, e.g. "/visit-42") where a participant joining starts the Assistant. */
    triggerRoomPattern: RegExp | null;
    maxSessions: number;
  };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

/** Names from earlier drafts of the spec. Corti's dashboard uses the new names, so we match it. */
const RENAMED: Record<string, string> = {
  CORTI_TENANT: "CORTI_TENANT_NAME",
  CORTI_ENV: "CORTI_ENVIRONMENT",
};

/**
 * Reads and validates configuration from environment variables.
 * Collects every problem before throwing, so one run shows everything that needs fixing.
 */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === "" ? undefined : value;
  };

  for (const [oldName, newName] of Object.entries(RENAMED)) {
    if (read(oldName) !== undefined) problems.push(`${oldName} has been renamed to ${newName}`);
  }

  const required = (name: string): string => {
    const value = read(name);
    if (value === undefined) problems.push(`${name} is required`);
    return value ?? "";
  };

  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = read(name) ?? fallback;
    if (!(allowed as readonly string[]).includes(value)) {
      problems.push(`${name} must be one of ${allowed.join(", ")} (got "${value}")`);
      return fallback;
    }
    return value as T;
  };

  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
      return fallback;
    }
    return value;
  };

  const pattern = (name: string): RegExp | null => {
    const raw = read(name);
    if (raw === undefined) return null;
    try {
      return new RegExp(raw);
    } catch (error) {
      problems.push(`${name} is not a valid regular expression: ${(error as Error).message}`);
      return null;
    }
  };

  const url = (name: string): URL | null => {
    const raw = read(name);
    if (raw === undefined) return null;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        problems.push(`${name} must be an http(s) URL (got "${raw}")`);
        return null;
      }
      return parsed;
    } catch {
      problems.push(`${name} is not a valid URL (got "${raw}")`);
      return null;
    }
  };

  const config: Config = {
    whereby: {
      assistantKey: required("WHEREBY_ASSISTANT_KEY"),
    },
    corti: {
      tenant: required("CORTI_TENANT_NAME"),
      clientId: required("CORTI_CLIENT_ID"),
      clientSecret: required("CORTI_CLIENT_SECRET"),
      region: oneOf("CORTI_ENVIRONMENT", ["eu", "us"], "eu"),
      primaryLanguage: read("PRIMARY_LANGUAGE") ?? "en",
      noteTemplateKey: required("NOTE_TEMPLATE_KEY"),
      retentionPolicy: oneOf("RETENTION_POLICY", ["none", "retain"], "none"),
    },
    clinicianExternalIdPattern: pattern("CLINICIAN_EXTERNAL_ID_PATTERN"),
    endGraceSeconds: integer("END_GRACE_SECONDS", 30, 0, 3600),
    port: integer("PORT", 8080, 1, 65535),
    outputWebhookUrl: url("OUTPUT_WEBHOOK_URL"),
    server: {
      publicUrl: url("PUBLIC_URL"),
      demoToken: read("DEMO_TOKEN") ?? null,
      webhookSecret: read("WHEREBY_WEBHOOK_SECRET") ?? null,
      triggerRoomPattern: pattern("TRIGGER_ROOM_PATTERN"),
      maxSessions: integer("MAX_SESSIONS", 4, 1, 50),
    },
  };
  const demoToken = config.server.demoToken;
  if (demoToken !== null && demoToken.length < 16) problems.push("DEMO_TOKEN must be at least 16 characters");

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
