import type { GlasstraceEnvVars, GlasstraceOptions } from "@glasstrace/protocol";

/**
 * Resolved configuration after merging explicit options with environment variables.
 */
export interface ResolvedConfig {
  apiKey: string | undefined;
  endpoint: string;
  forceEnable: boolean;
  verbose: boolean;
  /**
   * Whether the explicit decision-trace opt-in is set. Optional on the
   * exported shape so existing consumers that construct a `ResolvedConfig`
   * literal for the public helpers keep compiling; `resolveConfig` always
   * populates it, and the gate reads it as falsy when absent.
   */
  decisionTrace?: boolean;
  environment: string | undefined;
  coverageMapEnabled: boolean;
  nodeEnv: string | undefined;
  vercelEnv: string | undefined;
}

const DEFAULT_ENDPOINT = "https://api.glasstrace.dev";

/**
 * Reads all recognized Glasstrace environment variables from process.env.
 * Returns undefined for any variable not set. Never throws.
 */
export function readEnvVars(): GlasstraceEnvVars {
  return {
    GLASSTRACE_API_KEY: process.env.GLASSTRACE_API_KEY?.trim() || undefined,
    GLASSTRACE_FORCE_ENABLE: process.env.GLASSTRACE_FORCE_ENABLE,
    GLASSTRACE_ENV: process.env.GLASSTRACE_ENV,
    GLASSTRACE_COVERAGE_MAP: process.env.GLASSTRACE_COVERAGE_MAP,
    GLASSTRACE_DECISION_TRACE: process.env.GLASSTRACE_DECISION_TRACE,
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
}

/**
 * Merges explicit GlasstraceOptions with environment variables.
 * Explicit options take precedence over environment variables.
 */
export function resolveConfig(options?: GlasstraceOptions): ResolvedConfig {
  const env = readEnvVars();

  return {
    apiKey: options?.apiKey ?? env.GLASSTRACE_API_KEY,
    endpoint: options?.endpoint ?? DEFAULT_ENDPOINT,
    forceEnable: options?.forceEnable ?? env.GLASSTRACE_FORCE_ENABLE === "true",
    verbose: options?.verbose ?? false,
    // Decision tracing resolves from the option or the env var; the
    // `|| verbose` fold is applied at the gate (`decisionTraceEnabled`),
    // not here, so the resolved flag records only the explicit opt-in.
    decisionTrace: options?.decisionTrace ?? env.GLASSTRACE_DECISION_TRACE === "true",
    environment: env.GLASSTRACE_ENV,
    coverageMapEnabled: env.GLASSTRACE_COVERAGE_MAP === "true",
    nodeEnv: env.NODE_ENV,
    vercelEnv: env.VERCEL_ENV,
  };
}

/**
 * Returns true when the SDK should be inactive (production detected without force-enable).
 * Logic order:
 *   1. forceEnable === true → return false (override)
 *   2. NODE_ENV === 'production' → return true
 *   3. VERCEL_ENV === 'production' → return true
 *   4. Otherwise → return false
 */
export function isProductionDisabled(config: ResolvedConfig): boolean {
  if (config.forceEnable) {
    return false;
  }
  if (config.nodeEnv === "production") {
    return true;
  }
  if (config.vercelEnv === "production") {
    return true;
  }
  return false;
}

/**
 * Returns true when no API key is configured (anonymous mode).
 * Treats undefined, empty string, whitespace-only, and gt_anon_* keys as anonymous.
 */
export function isAnonymousMode(config: ResolvedConfig): boolean {
  if (config.apiKey === undefined) {
    return true;
  }
  if (config.apiKey.trim() === "") {
    return true;
  }
  if (config.apiKey.startsWith("gt_anon_")) {
    return true;
  }
  return false;
}
