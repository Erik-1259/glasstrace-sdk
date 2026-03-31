/**
 * Wire format types for SDK ↔ backend communication.
 *
 * These schemas define the request/response shapes for:
 * - SDK initialization (POST /v1/sdk/init)
 * - SDK health diagnostics (embedded in init requests)
 * - Discovery endpoint (GET /__glasstrace/config)
 * - Source map upload (POST /v1/source-maps)
 */

import { z } from "zod";
import { AnonApiKeySchema, BuildHashSchema, SessionIdSchema } from "./ids.js";
import { CaptureConfigSchema } from "./config.js";

// --- ImportGraphPayload ---

/** Test file import relationships, embedded in SDK init request. */
export const ImportGraphPayloadSchema = z.object({
  buildHash: BuildHashSchema,
  graph: z.record(z.string(), z.array(z.string())),
});
export type ImportGraphPayload = z.infer<typeof ImportGraphPayloadSchema>;

// --- SdkHealthReport ---

/** SDK health diagnostics included in init requests. */
export const SdkHealthReportSchema = z.object({
  tracesExportedSinceLastInit: z.number().int().nonnegative(),
  tracesDropped: z.number().int().nonnegative(),
  initFailures: z.number().int().nonnegative(),
  configAge: z.number().int().nonnegative().describe("milliseconds since last config sync"),
  sdkVersion: z.string(),
});
export type SdkHealthReport = z.infer<typeof SdkHealthReportSchema>;

// --- TierLimits ---

/** Rate and storage limits for the current subscription tier. */
export const TierLimitsSchema = z.object({
  tracesPerMinute: z.number().int().positive(),
  storageTtlHours: z.number().int().positive(),
  maxTraceSizeBytes: z.number().int().positive(),
  maxConcurrentSessions: z.number().int().positive(),
});
export type TierLimits = z.infer<typeof TierLimitsSchema>;

// --- SdkInitResponse ---

/**
 * Response from POST /v1/sdk/init.
 *
 * Note: SdkInitRequest is intentionally NOT in the protocol package.
 * The request schema includes backend-specific types (TierLimits,
 * SubscriptionStatus) that are not part of the public contract.
 * The backend owns the request validation; the SDK only needs to
 * understand the response.
 */
export const SdkInitResponseSchema = z.object({
  config: CaptureConfigSchema,
  subscriptionStatus: z.string().max(64),
  linkedAccountId: z.string().uuid().optional(),
  minimumSdkVersion: z.string(),
  apiVersion: z.string(),
  tierLimits: TierLimitsSchema,
});
export type SdkInitResponse = z.infer<typeof SdkInitResponseSchema>;

// --- DiscoveryResponse ---

/** SDK discovery endpoint response (SDK → browser extension). */
export const DiscoveryResponseSchema = z.object({
  key: AnonApiKeySchema,
  sessionId: SessionIdSchema,
});
export type DiscoveryResponse = z.infer<typeof DiscoveryResponseSchema>;

// --- SourceMapUploadResponse ---

/** Response from POST /v1/source-maps. */
export const SourceMapUploadResponseSchema = z.object({
  success: z.literal(true),
  buildHash: BuildHashSchema,
  fileCount: z.number().int().nonnegative(),
  totalSizeBytes: z.number().int().nonnegative(),
});
export type SourceMapUploadResponse = z.infer<typeof SourceMapUploadResponseSchema>;
