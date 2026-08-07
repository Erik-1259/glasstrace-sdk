import { describe, it, expect } from "vitest";
import {
  GlasstraceOptionsSchema,
  GlasstraceEnvVarsSchema,
  CaptureConfigSchema,
  ResultEvidenceCapabilitiesSchema,
  SdkCachedConfigSchema,
} from "../../../packages/protocol/src/config.js";
import { SdkInitResponseSchema } from "../../../packages/protocol/src/wire.js";

/** A minimal valid CaptureConfig input for envelope-focused cases. */
const baseCaptureConfig = {
  requestBodies: false,
  queryParamValues: false,
  envVarValues: false,
  fullConsoleOutput: false,
  importGraph: false,
};

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

  it("applies default false for optional sideEffectEvidence field", () => {
    const result = CaptureConfigSchema.safeParse({
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sideEffectEvidence).toBe(false);
    }
  });

  it("accepts sideEffectEvidence: true when explicitly opted in", () => {
    const result = CaptureConfigSchema.safeParse({
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      sideEffectEvidence: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sideEffectEvidence).toBe(true);
    }
  });

  it("rejects non-boolean sideEffectEvidence", () => {
    const result = CaptureConfigSchema.safeParse({
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      sideEffectEvidence: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("defaults captureFidelity to strict (fail-closed) when omitted", () => {
    const result = CaptureConfigSchema.safeParse({
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.captureFidelity).toBe("strict");
    }
  });

  it("accepts captureFidelity: full when the operator opts in", () => {
    const result = CaptureConfigSchema.safeParse({
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      captureFidelity: "full",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.captureFidelity).toBe("full");
    }
  });

  it("rejects an unknown captureFidelity value", () => {
    const result = CaptureConfigSchema.safeParse({
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      captureFidelity: "lax",
    });
    expect(result.success).toBe(false);
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

describe("CaptureConfigSchema — resultEvidenceCapabilities envelope", () => {
  it("leaves the envelope absent when omitted — no default converts absence into presence", () => {
    const result = CaptureConfigSchema.safeParse(baseCaptureConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resultEvidenceCapabilities).toBeUndefined();
      expect("resultEvidenceCapabilities" in result.data).toBe(false);
    }
  });

  it("accepts all four valid capability combinations", () => {
    for (const aggregateScalars of [false, true]) {
      for (const boundedRows of [false, true]) {
        const result = CaptureConfigSchema.safeParse({
          ...baseCaptureConfig,
          resultEvidenceCapabilities: {
            wireVersion: 1,
            aggregateScalars,
            boundedRows,
          },
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.resultEvidenceCapabilities).toEqual({
            wireVersion: 1,
            aggregateScalars,
            boundedRows,
          });
        }
      }
    }
  });

  it("rejects a future wire version rather than degrading", () => {
    const result = CaptureConfigSchema.safeParse({
      ...baseCaptureConfig,
      resultEvidenceCapabilities: {
        wireVersion: 2,
        aggregateScalars: true,
        boundedRows: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects partial envelopes", () => {
    for (const envelope of [
      {},
      { wireVersion: 1 },
      { wireVersion: 1, aggregateScalars: true },
      { aggregateScalars: true, boundedRows: true },
    ]) {
      const result = CaptureConfigSchema.safeParse({
        ...baseCaptureConfig,
        resultEvidenceCapabilities: envelope,
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects unknown envelope members — the nested object is closed", () => {
    const result = CaptureConfigSchema.safeParse({
      ...baseCaptureConfig,
      resultEvidenceCapabilities: {
        wireVersion: 1,
        aggregateScalars: true,
        boundedRows: false,
        provider: "prisma",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects coercible non-boolean members — no coercion", () => {
    for (const envelope of [
      { wireVersion: 1, aggregateScalars: "true", boundedRows: false },
      { wireVersion: 1, aggregateScalars: 1, boundedRows: false },
      { wireVersion: "1", aggregateScalars: true, boundedRows: false },
      { wireVersion: 1, aggregateScalars: true, boundedRows: null },
    ]) {
      const result = CaptureConfigSchema.safeParse({
        ...baseCaptureConfig,
        resultEvidenceCapabilities: envelope,
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects non-object envelope values", () => {
    for (const envelope of [true, 1, "enabled", [], null]) {
      const result = CaptureConfigSchema.safeParse({
        ...baseCaptureConfig,
        resultEvidenceCapabilities: envelope,
      });
      expect(result.success).toBe(false);
    }
  });

  it("exports the envelope schema standalone for consumers", () => {
    expect(
      ResultEvidenceCapabilitiesSchema.safeParse({
        wireVersion: 1,
        aggregateScalars: false,
        boundedRows: true,
      }).success,
    ).toBe(true);
    expect(ResultEvidenceCapabilitiesSchema.safeParse({}).success).toBe(false);
  });
});

describe("SdkInitResponseSchema — envelope integration", () => {
  const baseInitResponse = {
    config: baseCaptureConfig,
    subscriptionStatus: "active",
    minimumSdkVersion: "1.0.0",
    apiVersion: "1",
    tierLimits: {
      tracesPerMinute: 100,
      storageTtlHours: 24,
      maxTraceSizeBytes: 1_000_000,
      maxConcurrentSessions: 5,
    },
  };

  it("accepts an init response whose config carries a valid envelope", () => {
    const result = SdkInitResponseSchema.safeParse({
      ...baseInitResponse,
      config: {
        ...baseCaptureConfig,
        resultEvidenceCapabilities: {
          wireVersion: 1,
          aggregateScalars: true,
          boundedRows: false,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config.resultEvidenceCapabilities).toEqual({
        wireVersion: 1,
        aggregateScalars: true,
        boundedRows: false,
      });
    }
  });

  it("accepts an init response without the envelope", () => {
    const result = SdkInitResponseSchema.safeParse(baseInitResponse);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config.resultEvidenceCapabilities).toBeUndefined();
    }
  });

  it("rejects the whole response on a malformed envelope under direct parse", () => {
    const result = SdkInitResponseSchema.safeParse({
      ...baseInitResponse,
      config: {
        ...baseCaptureConfig,
        resultEvidenceCapabilities: { wireVersion: 2 },
      },
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

  it("accepts the optional decisionTrace flag", () => {
    const result = GlasstraceOptionsSchema.safeParse({ decisionTrace: true });
    expect(result.success).toBe(true);
  });

  it("rejects a non-boolean decisionTrace", () => {
    const result = GlasstraceOptionsSchema.safeParse({ decisionTrace: "true" });
    expect(result.success).toBe(false);
  });
});

describe("GlasstraceEnvVarsSchema", () => {
  it("accepts the optional GLASSTRACE_DECISION_TRACE env var", () => {
    const result = GlasstraceEnvVarsSchema.safeParse({
      GLASSTRACE_DECISION_TRACE: "true",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-string GLASSTRACE_DECISION_TRACE", () => {
    const result = GlasstraceEnvVarsSchema.safeParse({
      GLASSTRACE_DECISION_TRACE: true,
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
