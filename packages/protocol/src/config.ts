/**
 * SDK configuration types.
 */

import { z } from "zod";

/** SDK capture configuration: which events to capture. */
export const CaptureConfigSchema = z.object({
  requestBodies: z.boolean(),
  queryParamValues: z.boolean(),
  envVarValues: z.boolean(),
  fullConsoleOutput: z.boolean(),
  importGraph: z.boolean(),
  consoleErrors: z.boolean().optional().default(false),
  errorResponseBodies: z.boolean().optional().default(false),
  /**
   * Account opt-in for side-effect evidence emission.
   *
   * When `false` (default), `recordSideEffect()` is a silent no-op:
   * no allowlist evaluation runs and no `glasstrace.side_effect.*`
   * attribute reaches the wire. When `true`, allowlisted side-effect
   * metadata is attached to the active OTel span subject to the
   * client-side allowlist enforcement layered with the product's
   * storage-time filter as defense-in-depth.
   */
  sideEffectEvidence: z.boolean().optional().default(false),
  /**
   * Per-account value-fidelity capture posture (server-pushed).
   *
   * `strict` (default) is fail-closed: the SDK rejects raw wall-clock
   * timestamps and unhashed identifiers from the `scalar.*` channel at
   * emit time. `full` relaxes those rejections so raw magnitudes can be
   * surfaced — but only in conjunction with an explicit producer opt-in
   * (so a `full`-configured account still emits strict-shaped scalars
   * unless the producer also opts in). The operator owns this flag; it
   * is never derived from producer or request input. Absent on the wire
   * ⇒ `strict`.
   */
  captureFidelity: z.enum(["strict", "full"]).optional().default("strict"),
  /**
   * Per-account HMAC secret for pseudonymizing allowlisted identifier
   * columns (server-pushed; never echoed back or logged).
   *
   * When present (and only under `captureFidelity: "full"`), a passive
   * adapter projecting an `*Id` column hashes the raw identifier into a
   * stable `gthid_<hex>` token under this key before it reaches the wire,
   * so the raw value is never emitted. Absent (the default) ⇒ identifier
   * capture stays off (fail-closed): the adapter emits no `*Id` scalar
   * rather than a raw or unkeyed one. Scoped per account, so tokens do
   * not correlate across accounts.
   */
  attrHmacKey: z.string().optional(),
});
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;

/**
 * Value-fidelity capture posture (`strict` | `full`). Exported as the
 * single source of truth so the SDK's scalar validator binds to the same
 * domain as the wire config rather than re-declaring the literal union.
 */
export type CaptureFidelity = CaptureConfig["captureFidelity"];

/**
 * Cached config returned on SDK init.
 * Stores the full SdkInitResponse payload as a generic record to avoid
 * a circular dependency (wire.ts imports from config.ts).
 * Consumers should cast via SdkInitResponseSchema.parse() when reading.
 */
export const SdkCachedConfigSchema = z.object({
  response: z.record(z.string(), z.unknown()),
  cachedAt: z.number().int().nonnegative(),
});
export type SdkCachedConfig = z.infer<typeof SdkCachedConfigSchema>;

/** Developer-facing config for registerGlasstrace(). */
export const GlasstraceOptionsSchema = z.object({
  apiKey: z.string().optional(),
  endpoint: z.string().url().refine(
    (url) => url.startsWith("https://") || url.startsWith("http://"),
    { message: "Endpoint must use http:// or https://" },
  ).optional(),
  forceEnable: z.boolean().optional(),
  verbose: z.boolean().optional(),
});
export type GlasstraceOptions = z.infer<typeof GlasstraceOptionsSchema>;

/** All recognized SDK environment variables. */
export const GlasstraceEnvVarsSchema = z.object({
  GLASSTRACE_API_KEY: z.string().optional(),
  GLASSTRACE_FORCE_ENABLE: z.string().optional(),
  GLASSTRACE_ENV: z.string().optional(),
  GLASSTRACE_COVERAGE_MAP: z.string().optional(),
  NODE_ENV: z.string().optional(),
  VERCEL_ENV: z.string().optional(),
});
export type GlasstraceEnvVars = z.infer<typeof GlasstraceEnvVarsSchema>;
