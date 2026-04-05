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
});
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;

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
