/**
 * Wire format types for SDK ↔ backend communication.
 *
 * These schemas define the request/response shapes for:
 * - SDK initialization (POST /v1/sdk/init)
 * - SDK health diagnostics (embedded in init requests)
 * - Discovery endpoint (GET /__glasstrace/config)
 * - Source map upload (POST /v1/source-maps)
 * - Presigned source map upload (POST /v1/source-maps/presign, POST /v1/source-maps/manifest)
 */

import { z } from "zod";
import {
  AnonApiKeySchema,
  BuildHashSchema,
  DevApiKeySchema,
  SessionIdSchema,
} from "./ids.js";
import { CaptureConfigSchema } from "./config.js";
import {
  MAX_SOURCE_MAP_FILE_COUNT,
  MAX_SOURCE_MAP_FILE_PATH_LENGTH,
  MAX_SOURCE_MAP_FILE_SIZE,
} from "./constants.js";

/**
 * Maximum length of `clientToken` carried on a presigned upload response,
 * in characters. Mirrors the backend canonical bound.
 */
const MAX_PRESIGNED_CLIENT_TOKEN_LENGTH = 2048;

/**
 * Maximum length of `pathname` carried on a presigned upload response, in
 * characters. Mirrors the backend canonical bound.
 */
const MAX_PRESIGNED_PATHNAME_LENGTH = 1024;

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
  claimResult: z
    .object({
      newApiKey: DevApiKeySchema,
      accountId: z.string().uuid(),
      graceExpiresAt: z.number().int().positive(),
    })
    .optional(),
});
export type SdkInitResponse = z.infer<typeof SdkInitResponseSchema>;

// --- DiscoveryResponse ---

/**
 * SDK discovery endpoint response (SDK → browser extension).
 *
 * @drift-check ../glasstrace-product/docs/component-designs/sdk-discovery-endpoint.md §5.1 Schema
 */
export const DiscoveryResponseSchema = z.object({
  key: AnonApiKeySchema,
  sessionId: SessionIdSchema,
  claimed: z.boolean().optional(),
  accountHint: z.string().optional(),
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

// --- Presigned Source Map Upload ---

/**
 * Request to obtain presigned upload URLs for source map files.
 *
 * Per-file `filePath` is bounded to {@link MAX_SOURCE_MAP_FILE_PATH_LENGTH}
 * characters; `sizeBytes` is bounded to {@link MAX_SOURCE_MAP_FILE_SIZE} bytes.
 * The `files` array carries between 1 and {@link MAX_SOURCE_MAP_FILE_COUNT}
 * entries. These bounds mirror the backend canonical bounds (DISC-1562) so
 * external tooling that validates against the SDK schema observes the same
 * acceptance envelope the backend enforces at write time.
 */
export const PresignedUploadRequestSchema = z.object({
  buildHash: BuildHashSchema,
  files: z
    .array(
      z.object({
        filePath: z
          .string()
          .min(1)
          .max(
            MAX_SOURCE_MAP_FILE_PATH_LENGTH,
            `filePath length exceeds maximum of ${MAX_SOURCE_MAP_FILE_PATH_LENGTH} characters`,
          ),
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(
            MAX_SOURCE_MAP_FILE_SIZE,
            `sizeBytes exceeds maximum of ${MAX_SOURCE_MAP_FILE_SIZE} bytes (${MAX_SOURCE_MAP_FILE_SIZE / (1024 * 1024)} MiB)`,
          ),
      }),
    )
    .min(1)
    .max(
      MAX_SOURCE_MAP_FILE_COUNT,
      `files array exceeds maximum of ${MAX_SOURCE_MAP_FILE_COUNT} entries`,
    ),
});
export type PresignedUploadRequest = z.infer<typeof PresignedUploadRequestSchema>;

/**
 * Response containing presigned upload tokens and storage pathnames.
 *
 * Each entry in `files` carries a Vercel Blob `access` mode that pins the
 * storage visibility for the resulting blob in the wire contract (DISC-756).
 * The current Glasstrace SDK upload path passes a fixed `access: "public"`
 * to `@vercel/blob/client` `put()`; carrying the field on the response
 * keeps the protocol shape canonical so any future visibility mode is
 * negotiable without a schema change.
 *
 * `expiresAt` is a Unix timestamp in milliseconds since the epoch and uses
 * the canonical timestamp validator (`int().nonnegative()`) shared with the
 * backend wire schema.
 *
 * Per-file bounds mirror the backend canonical bounds (DISC-1562):
 *
 * - `filePath` ≤ {@link MAX_SOURCE_MAP_FILE_PATH_LENGTH} characters
 * - `clientToken` ≤ 2048 characters
 * - `pathname` ≤ 1024 characters
 * - `maxBytes` ≤ {@link MAX_SOURCE_MAP_FILE_SIZE} bytes (50 MiB)
 *
 * The `files` array carries between 1 and {@link MAX_SOURCE_MAP_FILE_COUNT}
 * entries. These bounds keep the SDK schema in lockstep with the backend
 * acceptance envelope; third-party tooling that validates against the SDK
 * schema sees the same upper bounds the backend enforces at write time.
 */
export const PresignedUploadResponseSchema = z.object({
  uploadId: z.string().uuid(),
  expiresAt: z.number().int().nonnegative(),
  files: z
    .array(
      z.object({
        filePath: z
          .string()
          .min(1)
          .max(
            MAX_SOURCE_MAP_FILE_PATH_LENGTH,
            `filePath length exceeds maximum of ${MAX_SOURCE_MAP_FILE_PATH_LENGTH} characters`,
          ),
        clientToken: z
          .string()
          .min(1)
          .max(
            MAX_PRESIGNED_CLIENT_TOKEN_LENGTH,
            `clientToken length exceeds maximum of ${MAX_PRESIGNED_CLIENT_TOKEN_LENGTH} characters`,
          ),
        pathname: z
          .string()
          .min(1)
          .max(
            MAX_PRESIGNED_PATHNAME_LENGTH,
            `pathname length exceeds maximum of ${MAX_PRESIGNED_PATHNAME_LENGTH} characters`,
          ),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(
            MAX_SOURCE_MAP_FILE_SIZE,
            `maxBytes exceeds maximum of ${MAX_SOURCE_MAP_FILE_SIZE} bytes (${MAX_SOURCE_MAP_FILE_SIZE / (1024 * 1024)} MiB)`,
          ),
        /** Vercel Blob access mode — explicit in the contract per DISC-756. */
        access: z.enum(["public"]),
      }),
    )
    .min(1)
    .max(
      MAX_SOURCE_MAP_FILE_COUNT,
      `files array exceeds maximum of ${MAX_SOURCE_MAP_FILE_COUNT} entries`,
    ),
});
export type PresignedUploadResponse = z.infer<typeof PresignedUploadResponseSchema>;

/**
 * Request to finalize a presigned upload by registering the manifest.
 *
 * Per-file `filePath` is bounded to {@link MAX_SOURCE_MAP_FILE_PATH_LENGTH}
 * characters; `sizeBytes` is bounded to {@link MAX_SOURCE_MAP_FILE_SIZE}
 * bytes. The `files` array carries between 1 and
 * {@link MAX_SOURCE_MAP_FILE_COUNT} entries. These bounds mirror the
 * backend canonical bounds (DISC-1562).
 */
export const SourceMapManifestRequestSchema = z.object({
  uploadId: z.string().uuid(),
  buildHash: BuildHashSchema,
  files: z
    .array(
      z.object({
        filePath: z
          .string()
          .min(1)
          .max(
            MAX_SOURCE_MAP_FILE_PATH_LENGTH,
            `filePath length exceeds maximum of ${MAX_SOURCE_MAP_FILE_PATH_LENGTH} characters`,
          ),
        sizeBytes: z
          .number()
          .int()
          .positive()
          .max(
            MAX_SOURCE_MAP_FILE_SIZE,
            `sizeBytes exceeds maximum of ${MAX_SOURCE_MAP_FILE_SIZE} bytes (${MAX_SOURCE_MAP_FILE_SIZE / (1024 * 1024)} MiB)`,
          ),
        blobUrl: z.string().url(),
      }),
    )
    .min(1)
    .max(
      MAX_SOURCE_MAP_FILE_COUNT,
      `files array exceeds maximum of ${MAX_SOURCE_MAP_FILE_COUNT} entries`,
    ),
});
export type SourceMapManifestRequest = z.infer<typeof SourceMapManifestRequestSchema>;

/** Response confirming source map manifest activation. */
export const SourceMapManifestResponseSchema = z.object({
  success: z.literal(true),
  buildHash: BuildHashSchema,
  fileCount: z.number().int().nonnegative(),
  totalSizeBytes: z.number().int().nonnegative(),
  activatedAt: z.number().int().positive(),
});
export type SourceMapManifestResponse = z.infer<typeof SourceMapManifestResponseSchema>;
