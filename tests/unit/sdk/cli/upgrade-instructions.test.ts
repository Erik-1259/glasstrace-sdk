import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runUpgradeInstructions } from "../../../../packages/sdk/src/cli/upgrade-instructions.js";

function tmpDir(): string {
  return join(tmpdir(), `glasstrace-test-${randomUUID()}`);
}

/**
 * Minimum scaffolding for `detectAgents()` to detect the desired set
 * of agents without running CLI binaries. `detectAgents` walks up to
 * the git root; we drop a `.git/` placeholder so that walk stops at
 * `testDir`. Then we create marker files for each requested agent.
 */
async function scaffoldProject(
  testDir: string,
  agents: Array<"claude" | "codex" | "cursor">,
  fileBodies: Partial<Record<string, string>>,
): Promise<void> {
  await mkdir(join(testDir, ".git"), { recursive: true });
  // package.json is required by some downstream paths and is
  // harmless here; init() expects it but runUpgradeInstructions
  // does not, so we add it for parity with realistic projects.
  await writeFile(
    join(testDir, "package.json"),
    JSON.stringify({ name: "fixture" }),
  );

  if (agents.includes("claude")) {
    // Claude marker can be either `.claude/` or `CLAUDE.md`. We use
    // `CLAUDE.md` so the info file path lines up with what's written
    // below.
    if (fileBodies["CLAUDE.md"] === undefined) {
      await writeFile(join(testDir, "CLAUDE.md"), "# Project\n");
    }
  }

  if (agents.includes("codex")) {
    if (fileBodies["codex.md"] === undefined) {
      await writeFile(join(testDir, "codex.md"), "# Codex project notes\n");
    }
  }

  if (agents.includes("cursor")) {
    // Cursor marker is `.cursorrules`. detect.ts also accepts
    // `.cursor/` but we use the file form to keep the scaffolding
    // minimal.
    if (fileBodies[".cursorrules"] === undefined) {
      await writeFile(join(testDir, ".cursorrules"), "Existing rules\n");
    }
  }

  for (const [path, body] of Object.entries(fileBodies)) {
    if (body === undefined) continue;
    await writeFile(join(testDir, path), body);
  }
}

describe("runUpgradeInstructions", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("refreshes a stamped CLAUDE.md managed section in place", async () => {
    const claudeBody = [
      "# Project",
      "",
      "<!-- glasstrace:mcp:start v=1.0.0 -->",
      "Old content from an older SDK",
      "<!-- glasstrace:mcp:end -->",
      "",
      "## Untouched section",
      "User-owned text here.",
    ].join("\n");
    await scaffoldProject(testDir, ["claude"], {
      "CLAUDE.md": claudeBody,
    });

    const result = await runUpgradeInstructions({ projectRoot: testDir });

    expect(result.exitCode).toBe(0);
    // refreshed paths are project-relative so output is portable
    // across machines (Codex feedback PR #247).
    expect(result.refreshed).toContain("CLAUDE.md");
    expect(result.errors).toEqual([]);

    const written = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
    expect(written).not.toContain("v=1.0.0");
    // vitest.config.ts defines __SDK_VERSION__ = "0.0.0-test" so the
    // refreshed stamp matches that literal under the test runner.
    expect(written).toContain("v=0.0.0-test");
    expect(written).toContain("## Untouched section");
    expect(written).toContain("User-owned text here.");
    // The decision paragraph (DISC-1593) is now in the rendered
    // managed section.
    expect(written).toContain(
      "runtime evidence would materially reduce uncertainty",
    );
  });

  it("refreshes a legacy unstamped managed section in place (DISC-1592 backward-compat)", async () => {
    const claudeBody = [
      "<!-- glasstrace:mcp:start -->",
      "Pre-SDK-050 content",
      "<!-- glasstrace:mcp:end -->",
    ].join("\n");
    await scaffoldProject(testDir, ["claude"], {
      "CLAUDE.md": claudeBody,
    });

    const result = await runUpgradeInstructions({ projectRoot: testDir });

    expect(result.exitCode).toBe(0);
    expect(result.refreshed).toContain("CLAUDE.md");

    const written = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
    // Single managed section after upgrade — no duplicate appended.
    const startCount = (written.match(/glasstrace:mcp:start/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(written).toContain("v=");
    expect(written).not.toContain("Pre-SDK-050 content");
  });

  it("skips a CLAUDE.md that has no managed section (does not append a block)", async () => {
    const claudeBody = "# My project\n\nHand-written content only.\n";
    await scaffoldProject(testDir, ["claude"], {
      "CLAUDE.md": claudeBody,
    });

    const result = await runUpgradeInstructions({ projectRoot: testDir });

    expect(result.exitCode).toBe(0);
    expect(result.skipped).toContain("CLAUDE.md");
    expect(result.refreshed).toEqual([]);

    // File content unchanged.
    const written = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
    expect(written).toBe(claudeBody);
  });

  it("refreshes every detected file in a multi-file project (CLAUDE.md + .cursorrules)", async () => {
    const claudeBody = [
      "<!-- glasstrace:mcp:start v=1.0.0 -->",
      "old claude",
      "<!-- glasstrace:mcp:end -->",
    ].join("\n");
    const cursorBody = [
      "# glasstrace:mcp:start",
      "old cursor (legacy)",
      "# glasstrace:mcp:end",
    ].join("\n");
    await scaffoldProject(testDir, ["claude", "cursor"], {
      "CLAUDE.md": claudeBody,
      ".cursorrules": cursorBody,
    });

    const result = await runUpgradeInstructions({ projectRoot: testDir });

    expect(result.exitCode).toBe(0);
    expect(result.refreshed.sort()).toEqual([".cursorrules", "CLAUDE.md"]);

    const claudeAfter = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
    const cursorAfter = await readFile(join(testDir, ".cursorrules"), "utf-8");
    expect(claudeAfter).not.toContain("old claude");
    expect(cursorAfter).not.toContain("old cursor (legacy)");
    expect(claudeAfter).toContain("<!-- glasstrace:mcp:start v=");
    expect(cursorAfter).toContain("# glasstrace:mcp:start v=");
  });

  it("refreshes only the file that has a managed section, leaving others alone", async () => {
    const claudeBody = [
      "<!-- glasstrace:mcp:start v=1.0.0 -->",
      "old",
      "<!-- glasstrace:mcp:end -->",
    ].join("\n");
    const cursorBody = "Hand-written cursor rules — no Glasstrace block.\n";
    await scaffoldProject(testDir, ["claude", "cursor"], {
      "CLAUDE.md": claudeBody,
      ".cursorrules": cursorBody,
    });

    const result = await runUpgradeInstructions({ projectRoot: testDir });

    expect(result.exitCode).toBe(0);
    expect(result.refreshed).toEqual(["CLAUDE.md"]);
    expect(result.skipped).toEqual([".cursorrules"]);

    const cursorAfter = await readFile(join(testDir, ".cursorrules"), "utf-8");
    expect(cursorAfter).toBe(cursorBody);
  });

  it("re-running the command produces byte-for-byte identical output (idempotent)", async () => {
    const claudeBody = [
      "<!-- glasstrace:mcp:start v=0.9.0 -->",
      "stale",
      "<!-- glasstrace:mcp:end -->",
    ].join("\n");
    await scaffoldProject(testDir, ["claude"], {
      "CLAUDE.md": claudeBody,
    });

    await runUpgradeInstructions({ projectRoot: testDir });
    const afterFirst = await readFile(join(testDir, "CLAUDE.md"), "utf-8");

    await runUpgradeInstructions({ projectRoot: testDir });
    const afterSecond = await readFile(join(testDir, "CLAUDE.md"), "utf-8");

    expect(afterSecond).toBe(afterFirst);
  });

  // Codex review on PR #247 (P2): a permission error during managed-
  // section detection must surface as a warning rather than a silent
  // "skipped". hasManagedSection() now propagates non-ENOENT errors
  // (covered by `inject.test.ts > hasManagedSection > throws on
  // EACCES`), and the CLI's try/catch here pushes them to
  // result.warnings.
  //
  // We do NOT exercise the warning path through this integration
  // surface today: `detectAgents()` calls `access(filePath, R_OK)`
  // before reporting an `infoFilePath`, so a chmod-0o000 file is
  // already filtered out as "info file does not exist" upstream and
  // hasManagedSection() is never reached. The propagation contract
  // is the load-bearing claim — the unit test in inject.test.ts
  // pins it; the integration warning is defensive against a future
  // detect.ts that becomes more lenient about R_OK or against TOCTOU
  // (file readable at detect time, unreadable at refresh time).

  it("returns no refreshed entries when no agents are detected", async () => {
    // Only `.git/` and `package.json` — no agent markers at all.
    await mkdir(join(testDir, ".git"), { recursive: true });
    await writeFile(
      join(testDir, "package.json"),
      JSON.stringify({ name: "fixture" }),
    );

    const result = await runUpgradeInstructions({ projectRoot: testDir });

    expect(result.exitCode).toBe(0);
    expect(result.refreshed).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
