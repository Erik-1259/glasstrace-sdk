import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Regression guard for DISC-1257.
 *
 * Two independent tsup defaults break `next dev --webpack` on the SDK:
 *
 * 1. The stock `esm_shims.js` injects static top-level
 *      import path from "path";
 *      import { fileURLToPath } from "url";
 *    pairs into emitted ESM chunks to synthesize `__dirname`/`__filename`.
 *    Those unprefixed Node built-in imports break `next dev --webpack`,
 *    which does not externalize them on the dev bundler path.
 *
 * 2. tsup defaults `removeNodeProtocol: true`, which registers an esbuild
 *    plugin that rewrites every `node:*` specifier in the SDK source
 *    (e.g. `import * as fs from "node:fs/promises"`) to the unprefixed
 *    form. Same failure mode on the webpack dev bundler path.
 *
 * The SDK opts out of both (`shims: false`, `removeNodeProtocol: false`
 * in `packages/sdk/tsup.config.ts`). This test re-asserts both guarantees:
 * - No emitted JS (ESM or CJS) contains the tsup shim header comment.
 * - Every Node-builtin specifier emitted by the SDK's own source retains
 *   its `node:` prefix.
 * - The ESM and CJS outputs of the `node-subpath` bundle each load
 *   successfully and expose matching observable behavior from
 *   `source-map-uploader`'s path helper (`discoverSourceMapFiles`) —
 *   the one module the SDK ships that does meaningful path derivation.
 *   The helper moved off the root barrel in SDK-029 and is reachable
 *   to external consumers via `@glasstrace/sdk/node` (SDK-030).
 *
 * See DISC-1257 and `packages/sdk/tsup.config.ts`.
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
// discoverSourceMapFiles moved off the root barrel in SDK-029; the
// path-helper regression probe now loads the node subpath's emitted
// bundles directly.
const esmNodeSubpath = path.join(distDir, "node-subpath.js");
const cjsNodeSubpath = path.join(distDir, "node-subpath.cjs");
const distExists =
  fsSync.existsSync(esmEntry) &&
  fsSync.existsSync(cjsEntry) &&
  fsSync.existsSync(esmNodeSubpath) &&
  fsSync.existsSync(cjsNodeSubpath);

const describeIfBuilt = distExists ? describe : describe.skip;

// Collect every emitted `.js` / `.cjs` file under dist/ with its contents.
// Both regression checks below walk the same tree; reading once keeps the
// test cheap even as the bundle grows.
async function readDistBundles(
  dir: string,
): Promise<Array<{ file: string; content: string }>> {
  const out: Array<{ file: string; content: string }> = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await readDistBundles(full)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))
    ) {
      out.push({ file: full, content: await fs.readFile(full, "utf-8") });
    }
  }
  return out;
}

describeIfBuilt("bundle shim regression (DISC-1257)", () => {
  it("preserves the `node:` prefix on SDK-sourced Node built-in imports", async () => {
    // The SDK source uses explicit `node:`-prefixed imports. tsup's
    // `removeNodeProtocol: true` default (overridden in tsup.config.ts)
    // strips that prefix on emit, producing specifiers that `next dev
    // --webpack` cannot resolve. This test asserts the override holds.
    //
    // We can't simply grep for unprefixed built-ins globally: the bundle
    // inlines third-party dependencies (e.g. `@opentelemetry/resources`)
    // whose own source uses unprefixed `fs`/`util`/`child_process`
    // imports, and those are not something we want to rewrite. We
    // instead assert:
    //   - the prefix is present at all (positive signal that the
    //     `removeNodeProtocol` override is in effect)
    //   - the `src/import-graph.ts` section — a known SDK source with
    //     unambiguous `node:fs/promises` / `node:path` imports — still
    //     carries the prefix in its emitted region. esbuild marks each
    //     per-source region with a `// src/<path>.ts` header comment,
    //     which we use as the slice boundary.
    const bundles = await readDistBundles(distDir);

    // Positive signal: at least one ESM chunk and one CJS bundle must
    // still contain a `node:`-prefixed import/require.
    const esmNodePrefixHits = bundles.filter(
      (b) => b.file.endsWith(".js") && /from ["']node:/.test(b.content),
    );
    const cjsNodePrefixHits = bundles.filter(
      (b) => b.file.endsWith(".cjs") && /require\(["']node:/.test(b.content),
    );

    expect(
      esmNodePrefixHits.length,
      `Expected at least one emitted ESM chunk to contain a \`from "node:…"\` import.
tsup's \`removeNodeProtocol\` default rewrites those to the unprefixed
form, which breaks \`next dev --webpack\`. Ensure
\`removeNodeProtocol: false\` is set in packages/sdk/tsup.config.ts.
See DISC-1257.`,
    ).toBeGreaterThan(0);

    expect(
      cjsNodePrefixHits.length,
      `Expected at least one emitted CJS bundle to contain a \`require("node:…")\` call.
Same root cause as the ESM assertion above. See DISC-1257.`,
    ).toBeGreaterThan(0);

    // Source-scoped signal: find the bundle that emits src/import-graph.ts
    // (which uses `node:fs/promises`, `node:path`, `node:crypto`) and
    // confirm its region carries the `node:` prefix on every built-in.
    const importGraphBundles = bundles.filter((b) =>
      b.content.includes("// src/import-graph.ts"),
    );
    expect(
      importGraphBundles.length,
      "Expected at least one emitted bundle to contain src/import-graph.ts.",
    ).toBeGreaterThan(0);

    for (const { file, content } of importGraphBundles) {
      const markerIndex = content.indexOf("// src/import-graph.ts");
      const nextMarker = content.indexOf("// src/", markerIndex + 1);
      const slice =
        nextMarker === -1
          ? content.slice(markerIndex)
          : content.slice(markerIndex, nextMarker);

      const prefixRegex = file.endsWith(".cjs")
        ? /require\(["']node:(fs|fs\/promises|path|crypto)["']\)/
        : /from ["']node:(fs|fs\/promises|path|crypto)["']/;

      expect(
        prefixRegex.test(slice),
        `src/import-graph.ts section of ${file} is missing a \`node:\`-prefixed
Node built-in import. tsup stripped the prefix. See DISC-1257.`,
      ).toBe(true);
    }
  });

  it("emitted JS contains no tsup `esm_shims.js` header comment", async () => {
    // The shim header is the stable marker tsup injects above the
    // offending `import path from "path"` / `import { fileURLToPath }
    // from "url"` pair. Failure here means someone reintroduced a code
    // path that trips tsup's auto-shim — usually a `__dirname` /
    // `__filename` / `import.meta.url` reference in source.
    const SHIM_MARKER = "// ../../node_modules/tsup/assets/esm_shims.js";

    const bundles = await readDistBundles(distDir);
    const offenders = bundles
      .filter((b) => b.content.includes(SHIM_MARKER))
      .map((b) => b.file);

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
    const esmUrl = pathToFileURL(esmNodeSubpath).href;

    const esmModule = (await import(esmUrl)) as {
      discoverSourceMapFiles: (buildDir: string) => Promise<
        Array<{ filePath: string; absolutePath: string; sizeBytes: number }>
      >;
    };

    const requireFromTest = createRequire(import.meta.url);
    const cjsModule = requireFromTest(cjsNodeSubpath) as {
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
