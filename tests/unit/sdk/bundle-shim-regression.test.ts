import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Regression guard for DISC-1257.
 *
 * tsup's stock `esm_shims.js` injects static top-level
 *   import path from "path";
 *   import { fileURLToPath } from "url";
 * pairs into emitted ESM chunks to synthesize `__dirname`/`__filename`.
 * Those unprefixed Node built-in imports break `next dev --webpack`,
 * which does not externalize them on the dev bundler path.
 *
 * This test re-asserts the guarantee:
 * - No emitted JS (ESM or CJS) contains the tsup shim header comment.
 * - The ESM and CJS outputs each load successfully and expose the same
 *   observable behavior from `source-map-uploader`'s path helper
 *   (`discoverSourceMapFiles`) — which is the one module the SDK
 *   ships that does meaningful path derivation.
 *
 * See DISC-1257 and `packages/sdk/tsup.config.ts` (`shims: false`).
 *
 * The test is skipped when the built `dist/` is not present (i.e. the
 * developer ran `vitest` without running `npm run build` first). The
 * CI workflow deliberately runs Build before Test so this guard is
 * active in CI — see the Build step comment in `.github/workflows/ci.yml`.
 */

const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(thisFileDir, "../../../packages/sdk/dist");
const esmEntry = path.join(distDir, "index.js");
const cjsEntry = path.join(distDir, "index.cjs");
const distExists = fsSync.existsSync(esmEntry) && fsSync.existsSync(cjsEntry);

const describeIfBuilt = distExists ? describe : describe.skip;

describeIfBuilt("bundle shim regression (DISC-1257)", () => {
  it("emitted JS contains no tsup `esm_shims.js` header comment", async () => {
    // Walk dist/ and check every .js / .cjs for the shim header comment.
    // The header is the stable marker tsup injects above the offending
    // `import path from "path"` / `import { fileURLToPath } from "url"`
    // pair. Failure here means someone reintroduced a code path that
    // trips tsup's auto-shim — usually a `__dirname` / `__filename` /
    // `import.meta.url` reference in source.
    const SHIM_MARKER = "// ../../node_modules/tsup/assets/esm_shims.js";

    const offenders: string[] = [];

    async function walk(dir: string): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (
          entry.isFile() &&
          (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))
        ) {
          const content = await fs.readFile(full, "utf-8");
          if (content.includes(SHIM_MARKER)) {
            offenders.push(full);
          }
        }
      }
    }

    await walk(distDir);

    expect(
      offenders,
      `tsup ESM shim detected in emitted bundle. This breaks next dev --webpack.
Set \`shims: false\` in packages/sdk/tsup.config.ts and replace any
\`__dirname\` / \`__filename\` usage with fileURLToPath(import.meta.url).
See DISC-1257.
Offending files:
${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("ESM and CJS outputs both load and expose matching path helpers", async () => {
    // Load the built ESM and CJS entries in parallel. The ESM entry uses
    // `await import()` with a file URL to get proper ESM resolution; the
    // CJS entry uses `createRequire` so we can call `require()` from the
    // test's own ESM context.
    const { createRequire } = await import("node:module");
    const esmUrl = pathToFileURL(esmEntry).href;

    const esmModule = (await import(esmUrl)) as {
      discoverSourceMapFiles: (buildDir: string) => Promise<
        Array<{ filePath: string; absolutePath: string; sizeBytes: number }>
      >;
    };

    const requireFromTest = createRequire(import.meta.url);
    const cjsModule = requireFromTest(cjsEntry) as {
      discoverSourceMapFiles: (buildDir: string) => Promise<
        Array<{ filePath: string; absolutePath: string; sizeBytes: number }>
      >;
    };

    expect(typeof esmModule.discoverSourceMapFiles).toBe("function");
    expect(typeof cjsModule.discoverSourceMapFiles).toBe("function");

    // Exercise the path helper from both entry shapes against the same
    // on-disk fixture. If `shims: false` had broken path derivation in
    // either output (e.g. a `ReferenceError: __dirname is not defined`
    // in ESM, or a missing `fileURLToPath` polyfill in CJS), this call
    // would throw or return differing results.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "glasstrace-bundle-"));
    try {
      await fs.mkdir(path.join(tmpDir, "static", "chunks"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, "static", "chunks", "main.js.map"),
        '{"version":3}',
      );
      await fs.mkdir(path.join(tmpDir, "nested", "dir"), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, "nested", "dir", "page.js.map"),
        '{"version":3}',
      );

      const [esmResult, cjsResult] = await Promise.all([
        esmModule.discoverSourceMapFiles(tmpDir),
        cjsModule.discoverSourceMapFiles(tmpDir),
      ]);

      // Normalize ordering (the underlying `readdir` does not guarantee order).
      const sort = (
        rs: Array<{ filePath: string; absolutePath: string; sizeBytes: number }>,
      ) => [...rs].sort((a, b) => a.filePath.localeCompare(b.filePath));

      const esmSorted = sort(esmResult);
      const cjsSorted = sort(cjsResult);

      expect(esmSorted.map((r) => r.filePath)).toEqual([
        "nested/dir/page.js",
        "static/chunks/main.js",
      ]);
      expect(cjsSorted.map((r) => r.filePath)).toEqual(
        esmSorted.map((r) => r.filePath),
      );
      expect(cjsSorted.map((r) => r.absolutePath)).toEqual(
        esmSorted.map((r) => r.absolutePath),
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
