import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readEnvVars,
  resolveConfig,
  isProductionDisabled,
  isAnonymousMode,
} from "../../../packages/sdk/src/env-detection.js";
import type { ResolvedConfig } from "../../../packages/sdk/src/env-detection.js";

describe("readEnvVars", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("reads GLASSTRACE_API_KEY from process.env", () => {
    process.env.GLASSTRACE_API_KEY = "gt_dev_test123";
    const vars = readEnvVars();
    expect(vars.GLASSTRACE_API_KEY).toBe("gt_dev_test123");
  });

  it("normalizes empty-string GLASSTRACE_API_KEY to undefined", () => {
    process.env.GLASSTRACE_API_KEY = "";
    const vars = readEnvVars();
    expect(vars.GLASSTRACE_API_KEY).toBeUndefined();
  });

  it("normalizes whitespace-only GLASSTRACE_API_KEY to undefined", () => {
    process.env.GLASSTRACE_API_KEY = "   ";
    const vars = readEnvVars();
    expect(vars.GLASSTRACE_API_KEY).toBeUndefined();
  });

  it("reads GLASSTRACE_FORCE_ENABLE from process.env", () => {
    process.env.GLASSTRACE_FORCE_ENABLE = "true";
    const vars = readEnvVars();
    expect(vars.GLASSTRACE_FORCE_ENABLE).toBe("true");
  });

  it("reads GLASSTRACE_ENV from process.env", () => {
    process.env.GLASSTRACE_ENV = "staging";
    const vars = readEnvVars();
    expect(vars.GLASSTRACE_ENV).toBe("staging");
  });

  it("reads GLASSTRACE_COVERAGE_MAP from process.env", () => {
    process.env.GLASSTRACE_COVERAGE_MAP = "true";
    const vars = readEnvVars();
    expect(vars.GLASSTRACE_COVERAGE_MAP).toBe("true");
  });

  it("reads NODE_ENV from process.env", () => {
    process.env.NODE_ENV = "production";
    const vars = readEnvVars();
    expect(vars.NODE_ENV).toBe("production");
  });

  it("reads VERCEL_ENV from process.env", () => {
    process.env.VERCEL_ENV = "preview";
    const vars = readEnvVars();
    expect(vars.VERCEL_ENV).toBe("preview");
  });

  it("error case: returns all fields undefined when no env vars set", () => {
    delete process.env.GLASSTRACE_API_KEY;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
    delete process.env.GLASSTRACE_ENV;
    delete process.env.GLASSTRACE_COVERAGE_MAP;
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
    const vars = readEnvVars();
    expect(vars.GLASSTRACE_API_KEY).toBeUndefined();
    expect(vars.GLASSTRACE_FORCE_ENABLE).toBeUndefined();
    expect(vars.GLASSTRACE_ENV).toBeUndefined();
    expect(vars.GLASSTRACE_COVERAGE_MAP).toBeUndefined();
    expect(vars.NODE_ENV).toBeUndefined();
    expect(vars.VERCEL_ENV).toBeUndefined();
  });
});

describe("resolveConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear all relevant env vars
    delete process.env.GLASSTRACE_API_KEY;
    delete process.env.GLASSTRACE_FORCE_ENABLE;
    delete process.env.GLASSTRACE_ENV;
    delete process.env.GLASSTRACE_COVERAGE_MAP;
    delete process.env.NODE_ENV;
    delete process.env.VERCEL_ENV;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("error case: returns safe defaults with no options and no env vars", () => {
    const config = resolveConfig();
    expect(config.apiKey).toBeUndefined();
    expect(config.endpoint).toBe("https://api.glasstrace.dev");
    expect(config.forceEnable).toBe(false);
    expect(config.verbose).toBe(false);
    expect(config.environment).toBeUndefined();
    expect(config.coverageMapEnabled).toBe(false);
  });

  it("reads apiKey from env vars", () => {
    process.env.GLASSTRACE_API_KEY = "gt_dev_envkey";
    const config = resolveConfig();
    expect(config.apiKey).toBe("gt_dev_envkey");
  });

  it("explicit options override env vars for apiKey", () => {
    process.env.GLASSTRACE_API_KEY = "gt_dev_envkey";
    const config = resolveConfig({ apiKey: "gt_dev_explicit" });
    expect(config.apiKey).toBe("gt_dev_explicit");
  });

  it("explicit options override env vars for endpoint", () => {
    const config = resolveConfig({ endpoint: "https://custom.api.dev" });
    expect(config.endpoint).toBe("https://custom.api.dev");
  });

  it("forceEnable from env var GLASSTRACE_FORCE_ENABLE=true", () => {
    process.env.GLASSTRACE_FORCE_ENABLE = "true";
    const config = resolveConfig();
    expect(config.forceEnable).toBe(true);
  });

  it("forceEnable from explicit option overrides env var", () => {
    process.env.GLASSTRACE_FORCE_ENABLE = "true";
    const config = resolveConfig({ forceEnable: false });
    expect(config.forceEnable).toBe(false);
  });

  it("verbose from explicit option", () => {
    const config = resolveConfig({ verbose: true });
    expect(config.verbose).toBe(true);
  });

  it("environment comes from GLASSTRACE_ENV", () => {
    process.env.GLASSTRACE_ENV = "staging";
    const config = resolveConfig();
    expect(config.environment).toBe("staging");
  });

  it("coverageMapEnabled comes from GLASSTRACE_COVERAGE_MAP=true", () => {
    process.env.GLASSTRACE_COVERAGE_MAP = "true";
    const config = resolveConfig();
    expect(config.coverageMapEnabled).toBe(true);
  });

  it("coverageMapEnabled is false for GLASSTRACE_COVERAGE_MAP=false", () => {
    process.env.GLASSTRACE_COVERAGE_MAP = "false";
    const config = resolveConfig();
    expect(config.coverageMapEnabled).toBe(false);
  });
});

describe("isProductionDisabled", () => {
  it("returns false when not in production", () => {
    const config: ResolvedConfig = {
      apiKey: "gt_dev_test",
      endpoint: "https://api.glasstrace.dev",
      forceEnable: false,
      verbose: false,
      environment: undefined,
      coverageMapEnabled: false,
      nodeEnv: "development",
      vercelEnv: undefined,
    };
    expect(isProductionDisabled(config)).toBe(false);
  });

  it("returns true when NODE_ENV=production", () => {
    const config: ResolvedConfig = {
      apiKey: "gt_dev_test",
      endpoint: "https://api.glasstrace.dev",
      forceEnable: false,
      verbose: false,
      environment: undefined,
      coverageMapEnabled: false,
      nodeEnv: "production",
      vercelEnv: undefined,
    };
    expect(isProductionDisabled(config)).toBe(true);
  });

  it("returns true when VERCEL_ENV=production", () => {
    const config: ResolvedConfig = {
      apiKey: "gt_dev_test",
      endpoint: "https://api.glasstrace.dev",
      forceEnable: false,
      verbose: false,
      environment: undefined,
      coverageMapEnabled: false,
      nodeEnv: undefined,
      vercelEnv: "production",
    };
    expect(isProductionDisabled(config)).toBe(true);
  });

  it("error case: forceEnable=true overrides NODE_ENV=production", () => {
    const config: ResolvedConfig = {
      apiKey: "gt_dev_test",
      endpoint: "https://api.glasstrace.dev",
      forceEnable: true,
      verbose: false,
      environment: undefined,
      coverageMapEnabled: false,
      nodeEnv: "production",
      vercelEnv: undefined,
    };
    expect(isProductionDisabled(config)).toBe(false);
  });

  it("forceEnable=true overrides VERCEL_ENV=production", () => {
    const config: ResolvedConfig = {
      apiKey: "gt_dev_test",
      endpoint: "https://api.glasstrace.dev",
      forceEnable: true,
      verbose: false,
      environment: undefined,
      coverageMapEnabled: false,
      nodeEnv: undefined,
      vercelEnv: "production",
    };
    expect(isProductionDisabled(config)).toBe(false);
  });

  it("returns false by default (no production indicators)", () => {
    const config: ResolvedConfig = {
      apiKey: "gt_dev_test",
      endpoint: "https://api.glasstrace.dev",
      forceEnable: false,
      verbose: false,
      environment: undefined,
      coverageMapEnabled: false,
      nodeEnv: undefined,
      vercelEnv: undefined,
    };
    expect(isProductionDisabled(config)).toBe(false);
  });
});

describe("isAnonymousMode", () => {
  const baseConfig: ResolvedConfig = {
    apiKey: undefined,
    endpoint: "https://api.glasstrace.dev",
    forceEnable: false,
    verbose: false,
    environment: undefined,
    coverageMapEnabled: false,
    nodeEnv: undefined,
    vercelEnv: undefined,
  };

  it("returns true when no API key configured", () => {
    expect(isAnonymousMode({ ...baseConfig, apiKey: undefined })).toBe(true);
  });

  it("returns true when API key is empty string", () => {
    expect(isAnonymousMode({ ...baseConfig, apiKey: "" })).toBe(true);
  });

  it("returns true when API key is whitespace-only", () => {
    expect(isAnonymousMode({ ...baseConfig, apiKey: "   " })).toBe(true);
  });

  it("returns true when API key has gt_anon_ prefix", () => {
    expect(isAnonymousMode({ ...baseConfig, apiKey: "gt_anon_xyz789" })).toBe(true);
  });

  it("returns false when gt_dev_ key is configured", () => {
    expect(isAnonymousMode({ ...baseConfig, apiKey: "gt_dev_abc123" })).toBe(false);
  });
});
