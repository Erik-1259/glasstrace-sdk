import { describe, it, expect } from "vitest";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * F003 edge-bundle gate test (SDK-028).
 *
 * Verifies four invariants of the new three-bundle emission:
 *
 * 1. `dist/edge-entry.js` loads and exposes the post-recon pruned
 *    symbol set (per the reconnaissance artifact for SDK-028). This
 *    is the positive assertion that the surviving edge-safe surface
 *    is reachable from the edge entry.
 *
 * 2. The production gate `scripts/check-edge-bundle.mjs` exits 0
 *    against the real emitted bundle. This guards the F003 closure
 *    claim as a unit test, so a change that would cause CI's
 *    `postbuild` to fail also fails `vitest` locally.
 *
 * 3. When the gate is pointed at a synthetic bundle that imports
 *    `node:fs`, it exits non-zero and names the offending specifier.
 *    This smoke-tests the gate itself — a gate that always passes is
 *    no gate. The synthetic bundle lives in a temp dir so the real
 *    `dist/` is never mutated (which would race with concurrent
 *    tests that walk it, e.g. `bundle-shim-regression.test.ts`).
 *
 * 4. The companion `dist/node-entry.js` and `dist/node-subpath.js`
 *    bundles are emitted alongside the edge entry. A silent failure
 *    to emit either one (e.g., a tsup config typo) would otherwise
 *    only surface in SDK-030 when the subpath exports wire up.
 *
 * The suite is skipped when `dist/edge-entry.js` is missing, matching
 * the skip behavior of `bundle-shim-regression.test.ts`. The CI
 * workflow runs build before test, so the guard is active in CI. The
 * node-entry/node-subpath existence check lives INSIDE a test rather
 * than the skip predicate so that a build that emits edge-entry but
 * not the node bundles fails loudly instead of silently skipping.
 */

const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
const sdkPkgDir = path.resolve(thisFileDir, "../../../packages/sdk");
const distDir = path.join(sdkPkgDir, "dist");
const edgeEntry = path.join(distDir, "edge-entry.js");
const nodeEntry = path.join(distDir, "node-entry.js");
const nodeSubpath = path.join(distDir, "node-subpath.js");
const gateScript = path.join(sdkPkgDir, "scripts", "check-edge-bundle.mjs");
const edgeBuilt = fsSync.existsSync(edgeEntry);

const describeIfBuilt = edgeBuilt ? describe : describe.skip;

describeIfBuilt("edge-entry bundle (SDK-028)", () => {
  it("emits the node-entry and node-subpath bundles alongside edge-entry", () => {
    // Assert (rather than skip) so a tsup config regression that drops
    // either bundle fails loudly. SDK-030 wires `./node` to
    // `dist/node-subpath.*`; a missing node-subpath would silently
    // break that wiring otherwise.
    expect(fsSync.existsSync(nodeEntry)).toBe(true);
    expect(fsSync.existsSync(nodeSubpath)).toBe(true);
  });

  it("emits node-entry and node-subpath bundles that import cleanly under Node ESM", async () => {
    // DISC-1280 (tsup's pass-through re-export quirk) can leave any
    // bundle referencing sibling paths that never get emitted, not
    // just edge-entry. Both Node-side bundles currently use the same
    // `export ... from "./mod.js"` authoring form that triggered the
    // quirk for a small edge-entry; this test pins their importability
    // directly from vitest so a regression fails `npm run test`, not
    // only the postbuild gate. (The postbuild gate also probes both
    // files — this is belt-and-suspenders coverage.)
    const nodeEntryMod = (await import(pathToFileURL(nodeEntry).href)) as Record<
      string,
      unknown
    >;
    const nodeSubpathMod = (await import(
      pathToFileURL(nodeSubpath).href
    )) as Record<string, unknown>;

    // Exact surfaces are enforced by other tests (the SDK-029 barrel-
    // narrowing brief and the SDK-030 subpath-wiring brief). Here we
    // only need to prove the bundles load and expose a non-empty
    // surface — zero-export bundles would mean tsup stripped every
    // re-export, which is its own kind of regression.
    expect(Object.keys(nodeEntryMod).length).toBeGreaterThan(0);
    expect(Object.keys(nodeSubpathMod).length).toBeGreaterThan(0);
  });

  it("loads and exposes the post-recon pruned edge-safe surface", async () => {
    // The post-recon pruned list (see /tmp/recon-SDK-028.md for the
    // per-symbol evidence). Keep this alphabetized so a diff to either
    // `src/edge-entry.ts` or this test reviews cleanly.
    const expected = [
      "SdkError",
      "captureCorrelationId",
      "createDiscoveryHandler",
      "GlasstraceSpanProcessor",
    ].sort();

    const mod = (await import(pathToFileURL(edgeEntry).href)) as Record<
      string,
      unknown
    >;
    const actual = Object.keys(mod).sort();

    expect(actual).toEqual(expected);
  });

  it("passes the F003 closure gate against the real emitted bundle", () => {
    // The gate is the load-bearing acceptance test for SDK-028 — run
    // it from the test runner too so a broken gate surfaces in
    // `npm run test`, not only in `postbuild`. Invoking `node` rather
    // than `bash` keeps the test cross-platform (Windows shells that
    // lack bash would otherwise fail to exec the gate).
    execFileSync(process.execPath, [gateScript], {
      cwd: sdkPkgDir,
      stdio: "pipe",
      encoding: "utf-8",
    });
  });

  it("rejects a synthetic bundle that references the Node `process` global", async () => {
    // Guards the stage-3 process-global scan in the gate. This test
    // exercises four non-dot forms that the first version of the
    // scan (a `\bprocess\s*\.` regex) missed — optional chaining,
    // bracket notation, destructuring, and re-aliasing — plus the
    // template-literal interpolation case that an earlier version of
    // the string stripper ate.
    //
    // The current scan uses esbuild's `define` to replace every
    // unbound `process` with a sentinel before scanning, so all of
    // these forms are caught uniformly and locally-shadowed names
    // (e.g., Zod's `export function process`) do not false-positive.
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "glasstrace-edge-gate-process-"),
    );
    const synthetic = path.join(tmpDir, "synthetic-edge-entry.js");
    try {
      await fs.writeFile(
        synthetic,
        [
          "// Synthetic bundle used by the SDK-028 gate smoke test.",
          "// Uses every non-dot `process` form the older regex missed,",
          "// plus the template-literal interpolation case.",
          "export const port = `${process.env.PORT ?? \"3000\"}`;",
          "export const optional = process?.env;",
          "export const bracket = process[\"env\"];",
          "export const { env } = process;",
          "const p = process;",
          "export const alias = p;",
        ].join("\n"),
        "utf-8",
      );

      let threw = false;
      let stderr = "";
      try {
        execFileSync(process.execPath, [gateScript, synthetic], {
          cwd: sdkPkgDir,
          stdio: "pipe",
          encoding: "utf-8",
        });
      } catch (err) {
        threw = true;
        const e = err as { stderr?: string | Buffer };
        stderr =
          typeof e.stderr === "string"
            ? e.stderr
            : (e.stderr?.toString() ?? "");
      }

      expect(threw).toBe(true);
      expect(stderr).toContain("`process` global");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a synthetic bundle that reaches `process` via `globalThis` or `global`", async () => {
    // Guards the round-7 Codex finding. `define: { process: ... }`
    // only replaces bare identifiers, so property-path access through
    // `globalThis` or `global` would slip through a sentinel scan
    // without additional define entries. The gate now registers
    // `globalThis.process` and `global.process` as define targets
    // pointing at the same sentinel, so any of these forms is caught.
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "glasstrace-edge-gate-globalthis-"),
    );
    const synthetic = path.join(tmpDir, "synthetic-edge-entry.js");
    try {
      await fs.writeFile(
        synthetic,
        [
          "// Synthetic bundle used by the SDK-028 gate smoke test.",
          "// Three routes to the Node `process` global that bypass the",
          "// bare-identifier `define`. All must be caught.",
          "export const a = globalThis.process.env.A;",
          "export const b = global.process.env.B;",
          "export const c = globalThis['process'];",
        ].join("\n"),
        "utf-8",
      );

      let threw = false;
      let stderr = "";
      try {
        execFileSync(process.execPath, [gateScript, synthetic], {
          cwd: sdkPkgDir,
          stdio: "pipe",
          encoding: "utf-8",
        });
      } catch (err) {
        threw = true;
        const e = err as { stderr?: string | Buffer };
        stderr =
          typeof e.stderr === "string"
            ? e.stderr
            : (e.stderr?.toString() ?? "");
      }

      expect(threw).toBe(true);
      expect(stderr).toContain("`process` global");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts a synthetic bundle whose only `process` is a local function (Zod case)", async () => {
    // The scope-aware `define` substitution must leave locally-bound
    // identifiers named `process` alone — otherwise dependencies like
    // Zod (which exports `function process` from `v4/core/to-json-
    // schema.js`) would false-positive through the edge bundle's
    // transitive closure. This test pins that behavior: a bundle whose
    // only `process` identifier is a local function declaration must
    // pass the gate.
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "glasstrace-edge-gate-local-process-"),
    );
    const synthetic = path.join(tmpDir, "synthetic-edge-entry.js");
    try {
      await fs.writeFile(
        synthetic,
        [
          "// Synthetic bundle used by the SDK-028 gate smoke test.",
          "// `process` is a local function, NOT a reference to the Node global.",
          "function process(x) { return x + 1; }",
          "export const port = process(41);",
        ].join("\n"),
        "utf-8",
      );

      // Gate must exit 0. execFileSync throws on non-zero exit.
      const stdout = execFileSync(process.execPath, [gateScript, synthetic], {
        cwd: sdkPkgDir,
        stdio: "pipe",
        encoding: "utf-8",
      });
      expect(stdout).toContain("closure clean");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a synthetic bundle with a dangling sibling reference (DISC-1280 regression)", async () => {
    // Guards the new ESM-resolvability probe in the gate. DISC-1280
    // documents a tsup quirk where pure `export ... from "./mod.js"`
    // entries emit references to sibling files that never get emitted.
    // The closure scan treats those references as external (clean);
    // only a Node-import probe catches the dangling reference. This
    // test builds a synthetic bundle pointing at a nonexistent sibling
    // and confirms the gate rejects it.
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "glasstrace-edge-gate-dangling-"),
    );
    const synthetic = path.join(tmpDir, "synthetic-edge-entry.js");
    try {
      await fs.writeFile(
        synthetic,
        [
          "// Synthetic bundle used by the SDK-028 gate smoke test.",
          "// The referenced sibling deliberately does NOT exist.",
          'export { missing } from "./missing-sibling.js";',
        ].join("\n"),
        "utf-8",
      );

      let threw = false;
      let stderr = "";
      try {
        execFileSync(process.execPath, [gateScript, synthetic], {
          cwd: sdkPkgDir,
          stdio: "pipe",
          encoding: "utf-8",
        });
      } catch (err) {
        threw = true;
        const e = err as { stderr?: string | Buffer };
        stderr =
          typeof e.stderr === "string"
            ? e.stderr
            : (e.stderr?.toString() ?? "");
      }

      expect(threw).toBe(true);
      expect(stderr).toContain("not resolvable under Node ESM");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails when a default Node-side probe target is missing from dist", async () => {
    // Guards the round-5 regression finding: the gate's stage-1
    // resolvability probe runs against `dist/node-entry.js` and
    // `dist/node-subpath.js` in addition to the edge bundle, so a
    // tsup emission regression in either Node bundle surfaces in
    // postbuild.
    //
    // The test builds an isolated fixture rather than mutating the
    // real `dist/` — Vitest runs test files in parallel by default,
    // and other edge-bundle / node-bundle tests read `dist/**`
    // concurrently. Renaming a real build artifact in place would
    // race against those reads (P2 finding from PR #176 round 7).
    //
    // The fixture symlinks `dist/node-entry.js` and both edge-entry
    // variants from the real `dist/` into the fixture dir, and
    // deliberately omits `node-subpath.js`. Then the gate is invoked
    // with `cwd` set to the fixture root; its `resolve("dist/...")`
    // calls therefore target the fixture's `dist/`, isolating the
    // mutation from the real build artifacts.
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "glasstrace-edge-gate-missing-"),
    );
    const fixtureDist = path.join(tmpDir, "dist");
    await fs.mkdir(fixtureDist, { recursive: true });
    // Symlink (not copy) to keep the fixture cheap and guarantee
    // any dependent chunk files are visible. Symlinking the whole
    // dist tree would bring node-subpath too — we want it missing.
    const distEntries = await fs.readdir(distDir);
    for (const name of distEntries) {
      if (name === "node-subpath.js" || name === "node-subpath.cjs") continue;
      await fs.symlink(path.join(distDir, name), path.join(fixtureDist, name));
    }
    try {
      let threw = false;
      let stderr = "";
      try {
        execFileSync(process.execPath, [gateScript], {
          cwd: tmpDir,
          stdio: "pipe",
          encoding: "utf-8",
        });
      } catch (err) {
        threw = true;
        const e = err as { stderr?: string | Buffer };
        stderr =
          typeof e.stderr === "string"
            ? e.stderr
            : (e.stderr?.toString() ?? "");
      }
      expect(threw).toBe(true);
      expect(stderr).toContain("node-subpath.js missing");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a synthetic bundle that imports a Node built-in", async () => {
    // Build a standalone synthetic bundle in a temp dir, point the
    // Node-side gate at it, and expect a non-zero exit plus an error
    // message that names the offending specifier. This exercises the
    // gate logic end-to-end without mutating the real `dist/`.
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "glasstrace-edge-gate-"),
    );
    const synthetic = path.join(tmpDir, "synthetic-edge-entry.js");
    try {
      await fs.writeFile(
        synthetic,
        [
          "// Synthetic bundle used by the SDK-028 gate smoke test.",
          "// The deliberately forbidden import below must make the gate fail.",
          'import "node:fs";',
          'export const ok = "synthetic";',
        ].join("\n"),
        "utf-8",
      );

      let threw = false;
      let stderr = "";
      try {
        execFileSync(process.execPath, [gateScript, synthetic], {
          cwd: sdkPkgDir,
          stdio: "pipe",
          encoding: "utf-8",
        });
      } catch (err) {
        threw = true;
        const e = err as { stderr?: string | Buffer };
        stderr =
          typeof e.stderr === "string"
            ? e.stderr
            : (e.stderr?.toString() ?? "");
      }

      expect(threw).toBe(true);
      expect(stderr).toContain("node:fs");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a synthetic bundle that imports a denylisted package subpath", async () => {
    // Guards the external-list fix applied in response to the round-3
    // Codex P2 finding on PR #176: `buildExternalList()` originally only
    // externalized bare `@vercel/blob`, so a `@vercel/blob/<subpath>`
    // import would be bundled instead of landing in the metafile, and
    // `isKnownNodeOnlyPackage()` — which matches against the resolved
    // file path — would no longer fire. The fix adds `${pkg}/*` to the
    // external list for every entry in `KNOWN_NODE_ONLY_PACKAGES`. This
    // test forges a bundle with such a subpath import and confirms the
    // gate's closure scan rejects it.
    //
    // The synthetic bundle is emitted as `.cjs` so the gate's stage-1
    // ESM-resolvability probe is skipped (edge-entry's .cjs variant is
    // also skip-listed for stage 1 because CJS requires a different
    // resolver). Without that, Node's loader fails first — with
    // `Cannot find package '@vercel/blob'` — before stage 2 ever runs,
    // which would mask a real regression of the external-list fix.
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "glasstrace-edge-gate-subpath-"),
    );
    const synthetic = path.join(tmpDir, "synthetic-edge-entry.cjs");
    try {
      await fs.writeFile(
        synthetic,
        [
          "// Synthetic bundle used by the SDK-028 gate smoke test.",
          "// The deliberately forbidden subpath import below must make the gate fail.",
          'require("@vercel/blob/client");',
          'module.exports = { ok: "synthetic" };',
        ].join("\n"),
        "utf-8",
      );

      let threw = false;
      let stderr = "";
      try {
        execFileSync(process.execPath, [gateScript, synthetic], {
          cwd: sdkPkgDir,
          stdio: "pipe",
          encoding: "utf-8",
        });
      } catch (err) {
        threw = true;
        const e = err as { stderr?: string | Buffer };
        stderr =
          typeof e.stderr === "string"
            ? e.stderr
            : (e.stderr?.toString() ?? "");
      }

      expect(threw).toBe(true);
      expect(stderr).toContain("@vercel/blob/client");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
