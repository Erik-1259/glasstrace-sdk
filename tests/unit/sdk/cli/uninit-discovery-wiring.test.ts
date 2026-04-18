/**
 * Uninit wiring tests for the DISC-1127 static discovery file.
 *
 * Verifies that `runUninit`:
 *   - Removes `public/.well-known/glasstrace.json` when present.
 *   - Removes the enclosing `.well-known/` directory when empty.
 *   - Leaves sibling files in `.well-known/` untouched.
 *   - Reports "Would remove ..." in dry-run mode without deleting.
 *   - Is a no-op (no summary line, no error) when the file is absent.
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AnonApiKey } from "@glasstrace/protocol";
import { runUninit } from "../../../../packages/sdk/src/cli/uninit.js";
import { writeDiscoveryFile } from "../../../../packages/sdk/src/cli/discovery-file.js";

const KEY = ("gt_anon_" + "a".repeat(48)) as AnonApiKey;

let tempDirs: string[] = [];

function createTmpProject(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "glasstrace-uninit-disc-"),
  );
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-project" }),
    "utf-8",
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("runUninit — discovery file cleanup", () => {
  it("removes public/.well-known/glasstrace.json on uninit", async () => {
    const dir = createTmpProject();
    writeDiscoveryFile(dir, KEY);
    const filePath = path.join(dir, "public", ".well-known", "glasstrace.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const result = await runUninit({
      projectRoot: dir,
      dryRun: false,
      prompt: async () => true,
    });

    expect(result.errors).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(
      result.summary.some((line) =>
        line.includes("public/.well-known/glasstrace.json"),
      ),
    ).toBe(true);
  });

  it("removes empty .well-known/ directory after removing the file", async () => {
    const dir = createTmpProject();
    writeDiscoveryFile(dir, KEY);
    const wellKnown = path.join(dir, "public", ".well-known");

    await runUninit({
      projectRoot: dir,
      dryRun: false,
      prompt: async () => true,
    });

    expect(fs.existsSync(wellKnown)).toBe(false);
  });

  it("preserves .well-known/ when a sibling file exists", async () => {
    const dir = createTmpProject();
    writeDiscoveryFile(dir, KEY);
    const sibling = path.join(dir, "public", ".well-known", "security.txt");
    fs.writeFileSync(sibling, "Contact: sec@example.com", "utf-8");

    await runUninit({
      projectRoot: dir,
      dryRun: false,
      prompt: async () => true,
    });

    expect(fs.existsSync(sibling)).toBe(true);
  });

  it("dry-run previews without deleting", async () => {
    const dir = createTmpProject();
    writeDiscoveryFile(dir, KEY);
    const filePath = path.join(dir, "public", ".well-known", "glasstrace.json");

    const result = await runUninit({
      projectRoot: dir,
      dryRun: true,
      prompt: async () => true,
    });

    expect(fs.existsSync(filePath)).toBe(true);
    expect(
      result.summary.some(
        (line) =>
          line.includes("[dry run]") &&
          line.includes("public/.well-known/glasstrace.json"),
      ),
    ).toBe(true);
  });

  it("is a silent no-op when the discovery file is absent", async () => {
    const dir = createTmpProject();

    const result = await runUninit({
      projectRoot: dir,
      dryRun: false,
      prompt: async () => true,
    });

    expect(result.errors).toEqual([]);
    expect(
      result.summary.some((line) =>
        line.includes(".well-known/glasstrace.json"),
      ),
    ).toBe(false);
  });

  it("dry-run previews an orphaned file in the non-inferred layout", async () => {
    // A SvelteKit project wrote static/.well-known/glasstrace.json, then
    // had svelte.config.js removed — the inferred layout is now `public`
    // but the discovery file is still in `static`. The dry-run preview
    // must still report the file that a real uninit would remove.
    const dir = createTmpProject();
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", type: "module" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, "svelte.config.js"),
      "export default {};",
      "utf-8",
    );
    writeDiscoveryFile(dir, KEY);
    // Drop the SvelteKit signal so `inferLayoutForDryRun` would pick
    // `public`; the file remains at `static/.well-known/glasstrace.json`.
    fs.unlinkSync(path.join(dir, "svelte.config.js"));

    const result = await runUninit({
      projectRoot: dir,
      dryRun: true,
      prompt: async () => true,
    });

    expect(
      result.summary.some(
        (line) =>
          line.includes("[dry run]") &&
          line.includes("static/.well-known/glasstrace.json"),
      ),
    ).toBe(true);
    // File was NOT actually removed in dry-run mode.
    expect(
      fs.existsSync(path.join(dir, "static", ".well-known", "glasstrace.json")),
    ).toBe(true);
  });

  it("targets static/ for SvelteKit projects", async () => {
    const dir = createTmpProject();
    // Upgrade the fixture to a SvelteKit layout
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "app", type: "module" }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(dir, "svelte.config.js"),
      "export default {};",
      "utf-8",
    );
    writeDiscoveryFile(dir, KEY);
    const filePath = path.join(dir, "static", ".well-known", "glasstrace.json");
    expect(fs.existsSync(filePath)).toBe(true);

    await runUninit({
      projectRoot: dir,
      dryRun: false,
      prompt: async () => true,
    });

    expect(fs.existsSync(filePath)).toBe(false);
  });
});
