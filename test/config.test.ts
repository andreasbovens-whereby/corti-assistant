import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const minimal = {
  WHEREBY_ASSISTANT_KEY: "wb-key",
  CORTI_TENANT: "tenant",
  CORTI_CLIENT_ID: "id",
  CORTI_CLIENT_SECRET: "secret",
  NOTE_TEMPLATE_KEY: "template",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(minimal);
    expect(config.corti.region).toBe("eu");
    expect(config.corti.primaryLanguage).toBe("en");
    expect(config.corti.retentionPolicy).toBe("none");
    expect(config.endGraceSeconds).toBe(30);
    expect(config.port).toBe(8080);
    expect(config.clinicianExternalIdPattern).toBeNull();
    expect(config.outputWebhookUrl).toBeNull();
  });

  it("parses optional values", () => {
    const config = loadConfig({
      ...minimal,
      CORTI_ENV: "us",
      RETENTION_POLICY: "retain",
      CLINICIAN_EXTERNAL_ID_PATTERN: "^dr-",
      END_GRACE_SECONDS: "10",
      PORT: "3000",
      OUTPUT_WEBHOOK_URL: "https://example.com/hook",
    });
    expect(config.corti.region).toBe("us");
    expect(config.corti.retentionPolicy).toBe("retain");
    expect(config.clinicianExternalIdPattern?.test("dr-smith")).toBe(true);
    expect(config.endGraceSeconds).toBe(10);
    expect(config.port).toBe(3000);
    expect(config.outputWebhookUrl?.href).toBe("https://example.com/hook");
  });

  it("reports every problem at once", () => {
    try {
      loadConfig({ CORTI_ENV: "asia", PORT: "abc", CLINICIAN_EXTERNAL_ID_PATTERN: "(" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { problems } = error as ConfigError;
      expect(problems).toEqual(
        expect.arrayContaining([
          "WHEREBY_ASSISTANT_KEY is required",
          "CORTI_TENANT is required",
          "CORTI_CLIENT_ID is required",
          "CORTI_CLIENT_SECRET is required",
          "NOTE_TEMPLATE_KEY is required",
          'CORTI_ENV must be one of eu, us (got "asia")',
          'PORT must be an integer between 1 and 65535 (got "abc")',
        ]),
      );
      expect(problems.some((p) => p.startsWith("CLINICIAN_EXTERNAL_ID_PATTERN"))).toBe(true);
    }
  });

  it("treats blank values as unset", () => {
    expect(() => loadConfig({ ...minimal, CORTI_TENANT: "  " })).toThrow(/CORTI_TENANT is required/);
  });
});
