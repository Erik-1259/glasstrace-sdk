import { describe, expect, it } from "vitest";
import * as nodeSubpath from "../../../packages/sdk/src/node-subpath.js";

/**
 * SDK-030 subpath contents test.
 *
 * Pins the exact runtime shape of the `@glasstrace/sdk/node` subpath
 * entry — the 10 Node-only value exports relocated from the root
 * barrel in SDK-029. The test imports the TypeScript source directly
 * (same pattern as `public-barrel.test.ts`) so a stray change to
 * `packages/sdk/src/node-subpath.ts` fails immediately.
 *
 * The published-specifier resolution (`import "@glasstrace/sdk/node"`
 * through the `exports` map) is separately smoke-tested at the
 * package's `postbuild` hook via
 * `packages/sdk/scripts/verify-subpath-resolution.sh`, which runs real
 * Node under both ESM and CJS against the emitted `dist/`. Together
 * the two gates verify both "what the subpath surfaces" and "the
 * subpath actually resolves under the names consumers will use".
 *
 * Type-only re-exports (`SourceMapFileInfo`, `SourceMapEntry`,
 * `BlobUploader`, `AutoUploadOptions`) are not runtime-visible and are
 * guarded by TypeScript compilation of consumers rather than this test
 * (a consumer that imports a removed type fails `tsc` with TS2307).
 */
describe("@glasstrace/sdk/node subpath contents (SDK-030)", () => {
  it("exports the 10 Node-only value symbols", () => {
    const actual = Object.keys(nodeSubpath).sort();
    expect(actual).toEqual([
      "PRESIGNED_THRESHOLD_BYTES",
      "buildImportGraph",
      "collectSourceMaps",
      "computeBuildHash",
      "discoverSourceMapFiles",
      "discoverTestFiles",
      "extractImports",
      "uploadSourceMaps",
      "uploadSourceMapsAuto",
      "uploadSourceMapsPresigned",
    ]);
  });

  it("PRESIGNED_THRESHOLD_BYTES matches the pinned constant", () => {
    // 4_500_000 bytes is the Vercel Blob upload-size cutoff above which
    // the uploader switches from single-request to presigned multipart;
    // see `packages/sdk/src/source-map-uploader.ts`. An accidental change
    // would silently shift the ingestion path, so pin the exact value
    // rather than a shape-only assertion.
    expect(nodeSubpath.PRESIGNED_THRESHOLD_BYTES).toBe(4_500_000);
  });

  it("all value exports are callable", () => {
    const fns = [
      "buildImportGraph",
      "collectSourceMaps",
      "computeBuildHash",
      "discoverSourceMapFiles",
      "discoverTestFiles",
      "extractImports",
      "uploadSourceMaps",
      "uploadSourceMapsAuto",
      "uploadSourceMapsPresigned",
    ] as const;
    for (const name of fns) {
      expect(typeof nodeSubpath[name]).toBe("function");
    }
  });
});
