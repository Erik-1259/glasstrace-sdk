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
    // Wave 17 agent-instruction body (Erik's 2026-05-09 Prompt 1)
    // is now rendered in the managed section. Pin the new
    // load-bearing decision-rule heading instead of the prior
    // SDK-050 / DISC-1593 paragraph wording.
    expect(written).toContain("### Call Glasstrace FIRST when:");
    expect(written).toContain("### SKIP Glasstrace when:");
    expect(written).toContain("### Workflow");
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

  it("refreshes every detected file in a multi-file project (Wave 18: writes canonical 2026 destinations + transitional .cursorrules)", async () => {
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
    // Wave 18: refreshed list reports the canonical destinations
    // (CLAUDE.md, .cursor/rules/glasstrace.mdc) — the legacy
    // .cursorrules is also written via the multi-target dispatcher
    // as a transitional fallback but is not separately listed in
    // `refreshed` since it follows the canonical destination.
    expect(result.refreshed.sort()).toEqual([
      ".cursor/rules/glasstrace.mdc",
      "CLAUDE.md",
    ]);

    const claudeAfter = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
    expect(claudeAfter).not.toContain("old claude");
    expect(claudeAfter).toContain("<!-- glasstrace:mcp:start v=");

    // The legacy .cursorrules (transitional fallback) is also
    // refreshed by the multi-target dispatcher; hash markers are
    // preserved per generateInfoSectionForCursorrulesLegacy.
    const cursorRulesAfter = await readFile(
      join(testDir, ".cursorrules"),
      "utf-8",
    );
    expect(cursorRulesAfter).not.toContain("old cursor (legacy)");
    expect(cursorRulesAfter).toContain("# glasstrace:mcp:start v=");

    // The canonical .cursor/rules/glasstrace.mdc destination was
    // created with YAML frontmatter + HTML markers per Wave 18.
    const mdcAfter = await readFile(
      join(testDir, ".cursor", "rules", "glasstrace.mdc"),
      "utf-8",
    );
    expect(mdcAfter).toContain("alwaysApply: true");
    expect(mdcAfter).toContain("<!-- glasstrace:mcp:start v=");
  });

  it("refreshes when ANY known destination has a managed section (Wave 18 broadened opt-in gate per DISC-1782)", async () => {
    // Pre-Wave-18 the gate was "canonical infoFilePath has managed
    // section". Post-Wave-18 the canonical destinations changed for
    // most agents (Codex codex.md → AGENTS.md; Cursor .cursorrules →
    // .cursor/rules/glasstrace.mdc; etc.) so the gate now also
    // checks legacy destinations to avoid skipping legacy users.
    const claudeBody = [
      "<!-- glasstrace:mcp:start v=1.0.0 -->",
      "old",
      "<!-- glasstrace:mcp:end -->",
    ].join("\n");
    // Cursor project: legacy .cursorrules has a managed section but
    // the new canonical .cursor/rules/glasstrace.mdc does not exist
    // yet. Wave 18 should still refresh (migrate) because the legacy
    // destination has a section.
    const cursorLegacyBody = [
      "# glasstrace:mcp:start v=1.0.0",
      "old legacy cursor",
      "# glasstrace:mcp:end",
    ].join("\n");
    await scaffoldProject(testDir, ["claude", "cursor"], {
      "CLAUDE.md": claudeBody,
      ".cursorrules": cursorLegacyBody,
    });

    const result = await runUpgradeInstructions({ projectRoot: testDir });

    expect(result.exitCode).toBe(0);
    expect(result.refreshed.sort()).toEqual([
      ".cursor/rules/glasstrace.mdc",
      "CLAUDE.md",
    ]);
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

  it("Codex P2 v5 regression: monorepo legacy-path resolution — agent detected via walk-up to git root resolves legacy paths against the foundDir, not against projectRoot", async () => {
    // Monorepo layout: testDir is the git root; the Codex legacy
    // file `codex.md` lives at the git root with a managed section;
    // the SDK is initialized in `packages/api/`. The agent is
    // detected via walk-up to the git root, so `agent.infoFilePath`
    // points at the gitRoot's AGENTS.md. The legacy-path helper
    // must resolve `codex.md` against the gitRoot (foundDir
    // derived from infoFilePath), NOT against the projectRoot
    // (`packages/api/`), or the migration would skip the user.
    await mkdir(join(testDir, ".git"), { recursive: true });
    await writeFile(
      join(testDir, "package.json"),
      JSON.stringify({ name: "monorepo" }),
    );
    // Legacy codex.md at the git root with a stale managed section.
    await writeFile(
      join(testDir, "codex.md"),
      [
        "<!-- glasstrace:mcp:start v=1.0.0 -->",
        "old codex content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
      "utf-8",
    );
    const apiDir = join(testDir, "packages", "api");
    await mkdir(apiDir, { recursive: true });
    await writeFile(
      join(apiDir, "package.json"),
      JSON.stringify({ name: "api" }),
    );

    const result = await runUpgradeInstructions({ projectRoot: apiDir });

    expect(result.exitCode).toBe(0);
    // The legacy codex.md at the git root is detected as
    // having a managed section → codex is opted in → AGENTS.md
    // gets created at the git root (where the agent's foundDir
    // resolved to).
    const agentsMdPath = join(testDir, "AGENTS.md");
    const agentsMd = await readFile(agentsMdPath, "utf-8");
    expect(agentsMd).toContain("<!-- glasstrace:mcp:start v=");
    expect(agentsMd).toContain("Glasstrace MCP");
  });

  it("returns no refreshed entries when no opted-in markers exist (Wave 18: generic fallback's canonical AGENTS.md is created only when a managed section already exists somewhere)", async () => {
    // Only `.git/` and `package.json` — no agent markers, no
    // pre-existing managed section anywhere. The Wave 18 opt-in
    // gate (anyHasManagedSection across canonical + legacy) returns
    // false, so the generic fallback is skipped — upgrade-
    // instructions does not first-time-install AGENTS.md without
    // a prior opt-in signal.
    await mkdir(join(testDir, ".git"), { recursive: true });
    await writeFile(
      join(testDir, "package.json"),
      JSON.stringify({ name: "fixture" }),
    );

    const result = await runUpgradeInstructions({ projectRoot: testDir });

    expect(result.exitCode).toBe(0);
    expect(result.refreshed).toEqual([]);
    // The generic fallback's AGENTS.md is added to skipped because
    // the agent loop iterates it (infoFilePath !== null after
    // Wave 18) and the opt-in gate returns false.
    expect(result.skipped).toEqual(["AGENTS.md"]);
  });
});
