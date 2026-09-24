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
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

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
      tenant: required("CORTI_TENANT"),
      clientId: required("CORTI_CLIENT_ID"),
      clientSecret: required("CORTI_CLIENT_SECRET"),
      region: oneOf("CORTI_ENV", ["eu", "us"], "eu"),
      primaryLanguage: read("PRIMARY_LANGUAGE") ?? "en",
      noteTemplateKey: required("NOTE_TEMPLATE_KEY"),
      retentionPolicy: oneOf("RETENTION_POLICY", ["none", "retain"], "none"),
    },
    clinicianExternalIdPattern: pattern("CLINICIAN_EXTERNAL_ID_PATTERN"),
    endGraceSeconds: integer("END_GRACE_SECONDS", 30, 0, 3600),
    port: integer("PORT", 8080, 1, 65535),
    outputWebhookUrl: url("OUTPUT_WEBHOOK_URL"),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
