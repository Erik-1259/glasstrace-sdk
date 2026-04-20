/**
 * Node-only subpath entry for `@glasstrace/sdk`.
 *
 * Re-exports exactly the symbols SDK-029 will remove from the root
 * barrel, so SDK-030 can wire them as `@glasstrace/sdk/node` without
 * a second round of list curation. The value and type enumerations
 * below must stay in sync with SDK-029 §Requirements 1–2; any change
 * here is a coordinated change there.
 *
 * This entry point is **not wired into `package.json#exports` yet** —
 * SDK-030 adds the `./node` subpath. SDK-028 only builds the bundle.
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
