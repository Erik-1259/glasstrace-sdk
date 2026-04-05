/**
 * SDK constants.
 */

import type { CaptureConfig } from "./config.js";

/** All glasstrace.* semantic attribute keys used by the SDK. */
export const GLASSTRACE_ATTRIBUTE_NAMES = {
  // Server-side attributes
  TRACE_TYPE: "glasstrace.trace.type",
  SESSION_ID: "glasstrace.session.id",
  CORRELATION_ID: "glasstrace.correlation.id",
  ENVIRONMENT: "glasstrace.environment",
  ROUTE: "glasstrace.route",
  HTTP_METHOD: "glasstrace.http.method",
  HTTP_STATUS_CODE: "glasstrace.http.status_code",
  HTTP_DURATION_MS: "glasstrace.http.duration_ms",
  ERROR_MESSAGE: "glasstrace.error.message",
  ERROR_CODE: "glasstrace.error.code",
  ERROR_CATEGORY: "glasstrace.error.category",
  ERROR_FIELD: "glasstrace.error.field",
  ORM_PROVIDER: "glasstrace.orm.provider",
  ORM_MODEL: "glasstrace.orm.model",
  ORM_OPERATION: "glasstrace.orm.operation",
  ORM_DURATION_MS: "glasstrace.orm.duration_ms",
  FETCH_URL: "glasstrace.fetch.url",
  FETCH_METHOD: "glasstrace.fetch.method",
  FETCH_STATUS_CODE: "glasstrace.fetch.status_code",
  FETCH_DURATION_MS: "glasstrace.fetch.duration_ms",
  FETCH_TARGET: "glasstrace.fetch.target",
  ENV_REFERENCED: "glasstrace.env.referenced",
  SOURCE_FILE: "glasstrace.source.file",
  SOURCE_LINE: "glasstrace.source.line",
  SOURCE_MAPPED: "glasstrace.source.mapped",

  // Client-side attributes
  PLATFORM: "glasstrace.platform",
  GESTURE_TYPE: "glasstrace.gesture.type",
  TRIGGER_TYPE: "glasstrace.trigger.type",
  ELEMENT_FINGERPRINT: "glasstrace.element.fingerprint",
  ELEMENT_CONFIDENCE: "glasstrace.element.confidence",
  TAB_ID: "glasstrace.tab.id",
} as const;

/** Default SDK capture config (conservative defaults). */
export const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  requestBodies: false,
  queryParamValues: false,
  envVarValues: false,
  fullConsoleOutput: false,
  importGraph: false,
  consoleErrors: false,
};
