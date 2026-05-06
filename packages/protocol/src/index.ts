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
  MAX_SOURCE_MAP_FILE_PATH_LENGTH,
  MAX_SOURCE_MAP_FILE_SIZE,
  MAX_SOURCE_MAP_FILE_COUNT,
} from "./constants.js";

// --- Session ID derivation ---
export { deriveSessionId } from "./session.js";

// --- Side-effect evidence value enums (SDK-049 / SCHEMA-036) ---
export {
  SIDE_EFFECT_OPERATION_KINDS,
  type SideEffectOperationKind,
  SIDE_EFFECT_SEMANTIC_FIELD_KEYS,
  type SideEffectSemanticFieldKey,
  SIDE_EFFECT_OMISSION_REASONS,
  type SideEffectOmissionReason,
  SIDE_EFFECT_OPERATION_STATUSES,
  type SideEffectOperationStatus,
  SIDE_EFFECT_OPERATION_PHASES,
  type SideEffectOperationPhase,
} from "./side-effect.js";
