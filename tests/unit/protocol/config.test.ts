import { describe, it, expect } from "vitest";
import {
  GlasstraceOptionsSchema,
  CaptureConfigSchema,
  SdkCachedConfigSchema,
} from "../../../packages/protocol/src/config.js";

describe("CaptureConfigSchema", () => {
  it("accepts a valid config with all fields", () => {
    const result = CaptureConfigSchema.safeParse({
      requestBodies: true,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: true,
      importGraph: false,
      consoleErrors: true,
    });
    expect(result.success).toBe(true);
  });

  it("applies default for optional consoleErrors field", () => {
    const result = CaptureConfigSchema.safeParse({
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.consoleErrors).toBe(false);
    }
  });

  it("rejects missing required fields", () => {
    const result = CaptureConfigSchema.safeParse({
      requestBodies: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-boolean values", () => {
    const result = CaptureConfigSchema.safeParse({
      requestBodies: "yes",
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("GlasstraceOptionsSchema", () => {
  it("accepts empty object (all fields optional)", () => {
    const result = GlasstraceOptionsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts valid options with all fields", () => {
    const result = GlasstraceOptionsSchema.safeParse({
      apiKey: "gt_dev_" + "a".repeat(48),
      endpoint: "https://ingest.glasstrace.dev",
      forceEnable: true,
      verbose: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects endpoint without protocol", () => {
    const result = GlasstraceOptionsSchema.safeParse({
      endpoint: "ingest.glasstrace.dev",
    });
    expect(result.success).toBe(false);
  });

  it("accepts http endpoint for local dev", () => {
    const result = GlasstraceOptionsSchema.safeParse({
      endpoint: "http://localhost:3001",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-boolean forceEnable", () => {
    const result = GlasstraceOptionsSchema.safeParse({
      forceEnable: "true",
    });
    expect(result.success).toBe(false);
  });
});

describe("SdkCachedConfigSchema", () => {
  it("accepts a valid cached config", () => {
    const result = SdkCachedConfigSchema.safeParse({
      response: { config: {}, subscriptionStatus: "active" },
      cachedAt: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative cachedAt", () => {
    const result = SdkCachedConfigSchema.safeParse({
      response: {},
      cachedAt: -1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing response", () => {
    const result = SdkCachedConfigSchema.safeParse({
      cachedAt: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer cachedAt", () => {
    const result = SdkCachedConfigSchema.safeParse({
      response: {},
      cachedAt: 1.5,
    });
    expect(result.success).toBe(false);
  });
});
