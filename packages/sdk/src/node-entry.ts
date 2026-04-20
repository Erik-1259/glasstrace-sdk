/**
 * Node-runtime entry point for `@glasstrace/sdk`.
 *
 * Re-exports every symbol from the current root barrel whose transitive
 * import closure touches a Node built-in (`fs`, `path`, `events`,
 * `async_hooks`, `https`, `http`, `url`, `crypto`, `child_process`,
 * `module`, etc.) or `@vercel/blob`. This is the Node-only surface of
 * the SDK.
 *
 * The classification was produced by the reconnaissance artifact for
 * SDK-028 (per-symbol esbuild probes). This file, plus `edge-entry.ts`,
 * partitions the root barrel into two runtime-scoped views. The root
 * barrel (`index.ts`) remains unchanged in this brief — SDK-029
 * narrows it; SDK-030 wires the subpath exports map.
 *
 * Consumers do **not** import this file directly yet — `package.json`
 * `exports` still points every consumer at `./dist/index.js`.
 */

// ---------- Symbols also re-exported from edge-entry (for completeness) ----------
// Node runtimes have no reason to import the edge subset via a separate
// entry; they can use this file alone.

export { SdkError } from "./errors.js";

export {
  readEnvVars,
  resolveConfig,
  isProductionDisabled,
  isAnonymousMode,
} from "./env-detection.js";
export type { ResolvedConfig } from "./env-detection.js";

export {
  deriveSessionId,
  getOrigin,
  getDateString,
  SessionManager,
} from "./session.js";

export { classifyFetchTarget } from "./fetch-classifier.js";
export type { FetchTarget } from "./fetch-classifier.js";

export { GlasstraceSpanProcessor } from "./span-processor.js";

export { captureCorrelationId } from "./correlation-id.js";
export type { CorrelationIdRequest } from "./correlation-id.js";

// ---------- Node-only symbols (refuted from edge-entry) ----------

export { getOrCreateAnonKey, readAnonKey } from "./anon-key.js";

export {
  loadCachedConfig,
  saveCachedConfig,
  sendInitRequest,
  performInit,
  getActiveConfig,
  getLinkedAccountId,
} from "./init-client.js";
export type { InitClaimResult } from "./init-client.js";

export { GlasstraceExporter } from "./enriching-exporter.js";
export type { GlasstraceExporterOptions } from "./enriching-exporter.js";

export {
  registerGlasstrace,
  getDiscoveryHandler,
} from "./register.js";

export { withGlasstraceConfig } from "./config-wrapper.js";

export { isReady, waitForReady, getStatus } from "./lifecycle.js";

export { createGlasstraceSpanProcessor } from "./coexistence.js";

export { captureError } from "./capture-error.js";

// ---------- Symbols also re-exported from node-subpath ----------
// Mirrored here so the Node-only audience gets the full current surface
// from a single entry; the subpath re-exports the same symbols at
// `@glasstrace/sdk/node` (wired in SDK-030).

export {
  discoverSourceMapFiles,
  collectSourceMaps,
  computeBuildHash,
  uploadSourceMaps,
  PRESIGNED_THRESHOLD_BYTES,
  uploadSourceMapsPresigned,
  uploadSourceMapsAuto,
} from "./source-map-uploader.js";
export type {
  SourceMapFileInfo,
  SourceMapEntry,
  BlobUploader,
  AutoUploadOptions,
} from "./source-map-uploader.js";

export {
  discoverTestFiles,
  extractImports,
  buildImportGraph,
} from "./import-graph.js";
