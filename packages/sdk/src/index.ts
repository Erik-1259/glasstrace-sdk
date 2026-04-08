// @glasstrace/sdk
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
export { getOrCreateAnonKey, readAnonKey } from "./anon-key.js";

// Init client + config cache
export {
  loadCachedConfig,
  saveCachedConfig,
  sendInitRequest,
  performInit,
  getActiveConfig,
} from "./init-client.js";
export type { InitClaimResult } from "./init-client.js";

// Custom span processor (deprecated — now a pass-through)
export { GlasstraceSpanProcessor } from "./span-processor.js";

// Enriching exporter — performs all glasstrace.* enrichment at export time
export { GlasstraceExporter } from "./enriching-exporter.js";
export type { GlasstraceExporterOptions } from "./enriching-exporter.js";

// Discovery endpoint
export { createDiscoveryHandler } from "./discovery-endpoint.js";

// registerGlasstrace orchestrator
export {
  registerGlasstrace,
  getDiscoveryHandler,
} from "./register.js";

// Config wrapper + source map uploader
export { withGlasstraceConfig } from "./config-wrapper.js";
export {
  collectSourceMaps,
  computeBuildHash,
  uploadSourceMaps,
} from "./source-map-uploader.js";
export type { SourceMapEntry } from "./source-map-uploader.js";

// Manual error capture
export { captureError } from "./capture-error.js";

// Import graph builder
export {
  discoverTestFiles,
  extractImports,
  buildImportGraph,
} from "./import-graph.js";
