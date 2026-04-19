import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AnonApiKey } from "@glasstrace/protocol";
import {
  DISCOVERY_FILE_VERSION,
  resolveStaticRoot,
  relativeDiscoveryPath,
  readExistingDiscoveryFile,
  writeDiscoveryFile,
  removeDiscoveryFile,
} from "../../../../packages/sdk/src/cli/discovery-file.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const KEY_A = ("gt_anon_" + "a".repeat(48)) as AnonApiKey;
const KEY_B = ("gt_anon_" + "b".repeat(48)) as AnonApiKey;

let tempDirs: string[] = [];

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "glasstrace-disc-file-test-"));
  tempDirs.push(dir);
  return dir;
}

function writePkgJson(dir: string, content: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(content), "utf-8");
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

// ---------------------------------------------------------------------------
// resolveStaticRoot
// ---------------------------------------------------------------------------

describe("resolveStaticRoot", () => {
  it("returns public/ for a plain Node project with no framework signals", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const result = resolveStaticRoot(dir);
    expect(result.layout).toBe("public");
    expect(result.absolutePath).toBe(path.join(dir, "public"));
  });

  it("returns public/ for a CJS project that would otherwise look SvelteKit-ish", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app", type: "commonjs" });
    fs.writeFileSync(path.join(dir, "svelte.config.js"), "// fake", "utf-8");
    const result = resolveStaticRoot(dir);
    expect(result.layout).toBe("public");
  });

  it("returns static/ when package.json is ESM AND svelte.config.js exists", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app", type: "module" });
    fs.writeFileSync(path.join(dir, "svelte.config.js"), "export default {};", "utf-8");
    const result = resolveStaticRoot(dir);
    expect(result.layout).toBe("static");
    expect(result.absolutePath).toBe(path.join(dir, "static"));
  });

  it("returns static/ when package.json is ESM AND svelte.config.ts exists", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app", type: "module" });
    fs.writeFileSync(path.join(dir, "svelte.config.ts"), "export default {};", "utf-8");
    const result = resolveStaticRoot(dir);
    expect(result.layout).toBe("static");
  });

  it("returns static/ when package.json is ESM AND src/app.html exists", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app", type: "module" });
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "app.html"), "<html></html>", "utf-8");
    const result = resolveStaticRoot(dir);
    expect(result.layout).toBe("static");
  });

  it("returns public/ when package.json is missing", () => {
    const dir = createTmpDir();
    const result = resolveStaticRoot(dir);
    expect(result.layout).toBe("public");
  });

  it("returns public/ when package.json is malformed JSON", () => {
    const dir = createTmpDir();
    fs.writeFileSync(path.join(dir, "package.json"), "{ not json", "utf-8");
    const result = resolveStaticRoot(dir);
    expect(result.layout).toBe("public");
  });
});

// ---------------------------------------------------------------------------
// relativeDiscoveryPath
// ---------------------------------------------------------------------------

describe("relativeDiscoveryPath", () => {
  it("returns public/.well-known/glasstrace.json for public layout", () => {
    expect(relativeDiscoveryPath("public")).toBe("public/.well-known/glasstrace.json");
  });
  it("returns static/.well-known/glasstrace.json for static layout", () => {
    expect(relativeDiscoveryPath("static")).toBe("static/.well-known/glasstrace.json");
  });
});

// ---------------------------------------------------------------------------
// readExistingDiscoveryFile
// ---------------------------------------------------------------------------

describe("readExistingDiscoveryFile", () => {
  it("returns null when the file does not exist", () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, "missing.json");
    expect(readExistingDiscoveryFile(filePath)).toBeNull();
  });

  it("returns null for non-JSON content", () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, "bad.json");
    fs.writeFileSync(filePath, "not json", "utf-8");
    expect(readExistingDiscoveryFile(filePath)).toBeNull();
  });

  it("returns null for JSON arrays", () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, "arr.json");
    fs.writeFileSync(filePath, "[]", "utf-8");
    expect(readExistingDiscoveryFile(filePath)).toBeNull();
  });

  it("returns null when version is missing", () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, "f.json");
    fs.writeFileSync(filePath, JSON.stringify({ key: KEY_A }), "utf-8");
    expect(readExistingDiscoveryFile(filePath)).toBeNull();
  });

  it("returns null when version is not a positive integer", () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, "f.json");
    fs.writeFileSync(filePath, JSON.stringify({ version: 0, key: KEY_A }), "utf-8");
    expect(readExistingDiscoveryFile(filePath)).toBeNull();
  });

  it("returns null when key fails AnonApiKey validation", () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, "f.json");
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, key: "bogus" }), "utf-8");
    expect(readExistingDiscoveryFile(filePath)).toBeNull();
  });

  it("accepts a valid v1 file and returns the key with empty extras", () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, "f.json");
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, key: KEY_A }), "utf-8");
    const result = readExistingDiscoveryFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.key).toBe(KEY_A);
    expect(result!.extras).toEqual({});
  });

  it("tolerates unknown integer version >= 1 (forward compatibility)", () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, "f.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 2, key: KEY_A, extra: "ok" }),
      "utf-8",
    );
    const result = readExistingDiscoveryFile(filePath);
    expect(result).not.toBeNull();
    expect(result!.key).toBe(KEY_A);
    expect(result!.extras).toEqual({ extra: "ok" });
  });

  it("preserves user-added extras in insertion order", () => {
    const dir = createTmpDir();
    const filePath = path.join(dir, "f.json");
    // Write literal JSON with a specific field order.
    fs.writeFileSync(
      filePath,
      `{"version":1,"key":"${KEY_A}","note":"hi","team":"eng"}`,
      "utf-8",
    );
    const result = readExistingDiscoveryFile(filePath);
    expect(result).not.toBeNull();
    expect(Object.keys(result!.extras)).toEqual(["note", "team"]);
  });
});

// ---------------------------------------------------------------------------
// writeDiscoveryFile — creation path
// ---------------------------------------------------------------------------

describe("writeDiscoveryFile — create", () => {
  it("creates public/.well-known/glasstrace.json with correct schema", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const result = writeDiscoveryFile(dir, KEY_A);
    expect(result.action).toBe("created");
    expect(result.layout).toBe("public");

    const written = fs.readFileSync(result.filePath, "utf-8");
    const parsed = JSON.parse(written);
    expect(parsed).toEqual({ version: DISCOVERY_FILE_VERSION, key: KEY_A });
  });

  it("creates nested public/.well-known/ directory when missing", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const wellKnown = path.join(dir, "public", ".well-known");
    expect(fs.existsSync(wellKnown)).toBe(false);
    writeDiscoveryFile(dir, KEY_A);
    expect(fs.existsSync(wellKnown)).toBe(true);
  });

  it("targets static/ for SvelteKit projects", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app", type: "module" });
    fs.writeFileSync(path.join(dir, "svelte.config.js"), "export default {};", "utf-8");
    const result = writeDiscoveryFile(dir, KEY_A);
    expect(result.action).toBe("created");
    expect(result.layout).toBe("static");
    expect(result.filePath).toBe(
      path.join(dir, "static", ".well-known", "glasstrace.json"),
    );
  });

  it("writes a trailing newline for clean diffs", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const result = writeDiscoveryFile(dir, KEY_A);
    const written = fs.readFileSync(result.filePath, "utf-8");
    expect(written.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// writeDiscoveryFile — re-init preservation
// ---------------------------------------------------------------------------

describe("writeDiscoveryFile — re-init preservation", () => {
  it("returns skipped-matches when the existing key matches", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    writeDiscoveryFile(dir, KEY_A);
    const result = writeDiscoveryFile(dir, KEY_A);
    expect(result.action).toBe("skipped-matches");
  });

  it("does not rewrite the file when skipped-matches (mtime stable)", async () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const first = writeDiscoveryFile(dir, KEY_A);
    const mtime1 = fs.statSync(first.filePath).mtimeMs;
    // Small delay so a rewrite would produce a different mtime.
    await new Promise((r) => setTimeout(r, 20));
    writeDiscoveryFile(dir, KEY_A);
    const mtime2 = fs.statSync(first.filePath).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it("preserves user-added extras when rewriting a stale key", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const wellKnown = path.join(dir, "public", ".well-known");
    fs.mkdirSync(wellKnown, { recursive: true });
    const filePath = path.join(wellKnown, "glasstrace.json");
    // Seed a valid v1 file with KEY_A plus a user-added field.
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, key: KEY_A, team: "eng" }, null, 2) + "\n",
      "utf-8",
    );

    const result = writeDiscoveryFile(dir, KEY_B);
    expect(result.action).toBe("updated-stale");

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed.version).toBe(1);
    expect(parsed.key).toBe(KEY_B);
    expect(parsed.team).toBe("eng");
  });

  it("overwrites a malformed file and reports skipped-foreign", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const wellKnown = path.join(dir, "public", ".well-known");
    fs.mkdirSync(wellKnown, { recursive: true });
    const filePath = path.join(wellKnown, "glasstrace.json");
    fs.writeFileSync(filePath, "not json at all", "utf-8");

    const result = writeDiscoveryFile(dir, KEY_A);
    expect(result.action).toBe("skipped-foreign");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed).toEqual({ version: 1, key: KEY_A });
  });

  it("overwrites a file whose key fails validation and does not preserve extras", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const wellKnown = path.join(dir, "public", ".well-known");
    fs.mkdirSync(wellKnown, { recursive: true });
    const filePath = path.join(wellKnown, "glasstrace.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, key: "bogus", leak: "secret" }),
      "utf-8",
    );

    const result = writeDiscoveryFile(dir, KEY_A);
    expect(result.action).toBe("skipped-foreign");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed).toEqual({ version: 1, key: KEY_A });
    expect(parsed.leak).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// writeDiscoveryFile — atomicity
// ---------------------------------------------------------------------------

describe("writeDiscoveryFile — atomicity", () => {
  it("leaves no tmp file behind on successful write", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const result = writeDiscoveryFile(dir, KEY_A);
    const wellKnown = path.dirname(result.filePath);
    const entries = fs.readdirSync(wellKnown);
    expect(entries).toEqual(["glasstrace.json"]);
  });
});

// ---------------------------------------------------------------------------
// removeDiscoveryFile
// ---------------------------------------------------------------------------

describe("removeDiscoveryFile", () => {
  it("returns not-found when the file does not exist (no throw)", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const result = removeDiscoveryFile(dir);
    expect(result.action).toBe("not-found");
    expect(result.directoryRemoved).toBe(false);
  });

  it("removes the file and the empty .well-known/ directory", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    writeDiscoveryFile(dir, KEY_A);
    const result = removeDiscoveryFile(dir);
    expect(result.action).toBe("removed");
    expect(result.directoryRemoved).toBe(true);
    const wellKnown = path.join(dir, "public", ".well-known");
    expect(fs.existsSync(wellKnown)).toBe(false);
  });

  it("preserves .well-known/ when a sibling file exists", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    writeDiscoveryFile(dir, KEY_A);
    const siblingPath = path.join(dir, "public", ".well-known", "security.txt");
    fs.writeFileSync(siblingPath, "Contact: sec@example.com", "utf-8");

    const result = removeDiscoveryFile(dir);
    expect(result.action).toBe("removed");
    expect(result.directoryRemoved).toBe(false);
    expect(fs.existsSync(siblingPath)).toBe(true);
  });

  it("targets static/ for SvelteKit projects", () => {
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app", type: "module" });
    fs.writeFileSync(path.join(dir, "svelte.config.js"), "export default {};", "utf-8");
    writeDiscoveryFile(dir, KEY_A);

    const result = removeDiscoveryFile(dir);
    expect(result.action).toBe("removed");
    expect(result.layout).toBe("static");
  });

  it("does not delete a pre-existing empty .well-known/ when no file existed", () => {
    // A user may have created `public/.well-known/` themselves (for
    // `security.txt`, say) but not yet populated it. Uninit must not
    // silently prune their directory as a side effect of running when
    // no Glasstrace file ever lived there.
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app" });
    const userWellKnown = path.join(dir, "public", ".well-known");
    fs.mkdirSync(userWellKnown, { recursive: true });

    const result = removeDiscoveryFile(dir);
    expect(result.action).toBe("not-found");
    expect(result.directoryRemoved).toBe(false);
    expect(fs.existsSync(userWellKnown)).toBe(true);
  });

  it("cleans up an orphaned file in the non-inferred layout", () => {
    // Scenario: init ran on a SvelteKit project (wrote static/...), then
    // the user mutated package.json so the heuristic no longer matches.
    // resolveStaticRoot now infers `public`, but the discovery file is
    // still in static/. removeDiscoveryFile must sweep both candidates.
    const dir = createTmpDir();
    writePkgJson(dir, { name: "app", type: "module" });
    fs.writeFileSync(path.join(dir, "svelte.config.js"), "export default {};", "utf-8");
    writeDiscoveryFile(dir, KEY_A);

    // Mutate signals so resolveStaticRoot now picks `public`.
    fs.unlinkSync(path.join(dir, "svelte.config.js"));

    const result = removeDiscoveryFile(dir);
    expect(result.action).toBe("removed");
    expect(result.layout).toBe("static");
    expect(fs.existsSync(path.join(dir, "static", ".well-known", "glasstrace.json"))).toBe(false);
  });
});
