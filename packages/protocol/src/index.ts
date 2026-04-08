/**
 * @glasstrace/protocol — shared types and wire format schemas.
 *
 * This package defines the public contract between the Glasstrace SDK
 * and the Glasstrace backend. Both the SDK (public) and the backend
 * (private) depend on this package.
 */

// --- Branded IDs ---
export {
  DevApiKeySchema,
  type DevApiKey,
  AnonApiKeySchema,
  type AnonApiKey,
  SessionIdSchema,
  type SessionId,
  BuildHashSchema,
  type BuildHash,
  createAnonApiKey,
  createBuildHash,
} from "./ids.js";

// --- Enums ---
export { SdkDiagnosticCodeSchema, type SdkDiagnosticCode } from "./enums.js";

// --- Configuration ---
export {
  CaptureConfigSchema,
  type CaptureConfig,
  SdkCachedConfigSchema,
  type SdkCachedConfig,
  GlasstraceOptionsSchema,
  type GlasstraceOptions,
  GlasstraceEnvVarsSchema,
  type GlasstraceEnvVars,
} from "./config.js";

// --- Wire Formats ---
export {
  ImportGraphPayloadSchema,
  type ImportGraphPayload,
  SdkHealthReportSchema,
  type SdkHealthReport,
  TierLimitsSchema,
  type TierLimits,
  SdkInitResponseSchema,
  type SdkInitResponse,
  DiscoveryResponseSchema,
  type DiscoveryResponse,
  SourceMapUploadResponseSchema,
  type SourceMapUploadResponse,
  PresignedUploadRequestSchema,
  type PresignedUploadRequest,
  PresignedUploadResponseSchema,
  type PresignedUploadResponse,
  SourceMapManifestRequestSchema,
  type SourceMapManifestRequest,
  SourceMapManifestResponseSchema,
  type SourceMapManifestResponse,
} from "./wire.js";

// --- Constants ---
export {
  GLASSTRACE_ATTRIBUTE_NAMES,
  DEFAULT_CAPTURE_CONFIG,
} from "./constants.js";
