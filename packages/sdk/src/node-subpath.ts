/**
 * Node-only subpath entry for `@glasstrace/sdk`, published as
 * `@glasstrace/sdk/node` via `package.json#exports` (resolves under the
 * Node condition only). Holds the symbols that depend on Node built-ins
 * or otherwise belong off the edge-safe root barrel: the build-time
 * source-map and import-graph tooling, and the request-time `hashId`
 * identifier-pseudonymization helper (which uses `node:crypto`).
 */

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

/**
 * Producer-side identifier pseudonymization for `*Id` value-fidelity
 * scalars. Node-only because it uses `node:crypto`; pre-hash `*Id`
 * values with this before passing them to `recordSideEffect({ scalars })`
 * (see {@link import("./side-effect/allowlist.js").checkScalarField}).
 */
export { hashId } from "./side-effect/hash-id.js";
