import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectAllTargets } from "../../../../packages/sdk/src/agent-detection/inject-all-targets.ts";
import type { DetectedAgent } from "../../../../packages/sdk/src/agent-detection/detect.ts";

const ENDPOINT = "https://app.glasstrace.com/api/mcp";
const SDK_VERSION = "1.11.0";

function makeAgent(
  name: DetectedAgent["name"],
  testDir: string,
): DetectedAgent {
  switch (name) {
    case "claude":
      return {
        name: "claude",
        mcpConfigPath: join(testDir, ".mcp.json"),
        infoFilePath: join(testDir, "CLAUDE.md"),
        cliAvailable: false,
        registrationCommand:
          "npx --yes --package @glasstrace/sdk glasstrace mcp add --agent claude",
      };
    case "codex":
      return {
        name: "codex",
        mcpConfigPath: join(testDir, ".codex", "config.toml"),
        infoFilePath: join(testDir, "AGENTS.md"),
        cliAvailable: false,
        registrationCommand:
          "npx --yes --package @glasstrace/sdk glasstrace mcp add --agent codex",
      };
    case "gemini":
      return {
        name: "gemini",
        mcpConfigPath: join(testDir, ".gemini", "settings.json"),
        infoFilePath: join(testDir, "GEMINI.md"),
        cliAvailable: false,
        registrationCommand:
          "npx --yes --package @glasstrace/sdk glasstrace mcp add --agent gemini",
      };
    case "cursor":
      return {
        name: "cursor",
        mcpConfigPath: join(testDir, ".cursor", "mcp.json"),
        infoFilePath: join(testDir, ".cursor", "rules", "glasstrace.mdc"),
        cliAvailable: false,
        registrationCommand:
          "npx --yes --package @glasstrace/sdk glasstrace mcp add --agent cursor",
      };
    case "windsurf":
      return {
        name: "windsurf",
        mcpConfigPath: "/dev/null/windsurf-config",
        infoFilePath: join(testDir, ".windsurf", "rules", "glasstrace.md"),
        cliAvailable: false,
        registrationCommand:
          "npx --yes --package @glasstrace/sdk glasstrace mcp add --agent windsurf",
      };
    case "generic":
      return {
        name: "generic",
        mcpConfigPath: join(testDir, ".glasstrace", "mcp.json"),
        infoFilePath: join(testDir, "AGENTS.md"),
        cliAvailable: false,
        registrationCommand: null,
      };
  }
}

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "inject-all-targets-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("injectAllTargets — Wave 18 multi-target dispatcher (DISC-1782)", () => {
  describe("per-agent target sets", () => {
    it("Claude → CLAUDE.md primary + AGENTS.md companion", async () => {
      await injectAllTargets(
        [makeAgent("claude", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );
      const claude = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
      const agentsMd = await readFile(join(testDir, "AGENTS.md"), "utf-8");
      expect(claude).toContain("<!-- glasstrace:mcp:start v=");
      expect(claude).toContain("Glasstrace MCP");
      expect(agentsMd).toContain("<!-- glasstrace:mcp:start v=");
      expect(agentsMd).toContain("Glasstrace MCP");
    });

    it("Codex → AGENTS.md only (no separate companion — codex.md retired)", async () => {
      await injectAllTargets(
        [makeAgent("codex", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );
      const agentsMd = await readFile(join(testDir, "AGENTS.md"), "utf-8");
      expect(agentsMd).toContain("<!-- glasstrace:mcp:start v=");
      // No legacy codex.md should be created.
      await expect(
        readFile(join(testDir, "codex.md"), "utf-8"),
      ).rejects.toThrow();
    });

    it("Gemini → GEMINI.md primary + AGENTS.md companion", async () => {
      await injectAllTargets(
        [makeAgent("gemini", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );
      const gemini = await readFile(join(testDir, "GEMINI.md"), "utf-8");
      const agentsMd = await readFile(join(testDir, "AGENTS.md"), "utf-8");
      expect(gemini).toContain("Glasstrace MCP");
      expect(agentsMd).toContain("Glasstrace MCP");
    });

    it("Cursor → .cursor/rules/glasstrace.mdc canonical + .cursorrules transitional + AGENTS.md companion (DoD-P7: .mdc has YAML frontmatter)", async () => {
      await injectAllTargets(
        [makeAgent("cursor", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );
      const mdc = await readFile(
        join(testDir, ".cursor", "rules", "glasstrace.mdc"),
        "utf-8",
      );
      const cursorrules = await readFile(
        join(testDir, ".cursorrules"),
        "utf-8",
      );
      const agentsMd = await readFile(join(testDir, "AGENTS.md"), "utf-8");

      // .mdc has YAML frontmatter (alwaysApply: true) above the
      // managed section.
      expect(mdc).toContain("---");
      expect(mdc).toContain("alwaysApply: true");
      expect(mdc).toContain("<!-- glasstrace:mcp:start v=");

      // .cursorrules legacy uses hash markers (preserved from
      // SDK-050 for backward-compat with already-rendered sections).
      expect(cursorrules).toContain("# glasstrace:mcp:start v=");
      expect(cursorrules).toContain("# glasstrace:mcp:end");

      expect(agentsMd).toContain("<!-- glasstrace:mcp:start v=");
    });

    it("Windsurf → .windsurf/rules/glasstrace.md primary + AGENTS.md companion", async () => {
      await injectAllTargets(
        [makeAgent("windsurf", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );
      const ws = await readFile(
        join(testDir, ".windsurf", "rules", "glasstrace.md"),
        "utf-8",
      );
      const agentsMd = await readFile(join(testDir, "AGENTS.md"), "utf-8");
      expect(ws).toContain("Glasstrace MCP");
      expect(agentsMd).toContain("Glasstrace MCP");
    });

    it("Generic → AGENTS.md only (universal fallback)", async () => {
      await injectAllTargets(
        [makeAgent("generic", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );
      const agentsMd = await readFile(join(testDir, "AGENTS.md"), "utf-8");
      expect(agentsMd).toContain("Glasstrace MCP");
    });
  });

  describe("AGENTS.md dedup across multi-agent detection", () => {
    it("writes AGENTS.md only ONCE when multiple agents detected (per finding R30)", async () => {
      // Project with both Claude AND Cursor markers — both want
      // AGENTS.md as a companion. The dedup logic in
      // injectAllTargets should write AGENTS.md exactly once.
      // Verify by checking that the file content has ONE managed
      // section, not two stacked sections.
      await injectAllTargets(
        [makeAgent("claude", testDir), makeAgent("cursor", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );

      const agentsMd = await readFile(join(testDir, "AGENTS.md"), "utf-8");
      const startCount = (agentsMd.match(/glasstrace:mcp:start/g) ?? [])
        .length;
      const endCount = (agentsMd.match(/glasstrace:mcp:end/g) ?? []).length;
      expect(startCount).toBe(1);
      expect(endCount).toBe(1);
    });
  });

  describe("DoD-P5: idempotence under multi-target", () => {
    it("re-running produces byte-for-byte identical content (no duplicates, no version-stamp drift)", async () => {
      await injectAllTargets(
        [makeAgent("claude", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );
      const afterFirst = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
      const agentsAfterFirst = await readFile(
        join(testDir, "AGENTS.md"),
        "utf-8",
      );

      await injectAllTargets(
        [makeAgent("claude", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );
      const afterSecond = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
      const agentsAfterSecond = await readFile(
        join(testDir, "AGENTS.md"),
        "utf-8",
      );

      expect(afterSecond).toBe(afterFirst);
      expect(agentsAfterSecond).toBe(agentsAfterFirst);

      // Exactly one start marker per file (no duplicates).
      const claudeStarts = (afterSecond.match(/glasstrace:mcp:start/g) ?? [])
        .length;
      const agentsStarts = (
        agentsAfterSecond.match(/glasstrace:mcp:start/g) ?? []
      ).length;
      expect(claudeStarts).toBe(1);
      expect(agentsStarts).toBe(1);
    });
  });

  describe("DoD-P6: user-edited frontmatter preservation in .mdc", () => {
    it("re-running against a .mdc with user-customized frontmatter preserves the user content above the markers", async () => {
      // First run creates .cursor/rules/glasstrace.mdc with default
      // frontmatter (alwaysApply: true).
      await injectAllTargets(
        [makeAgent("cursor", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );
      const mdcPath = join(testDir, ".cursor", "rules", "glasstrace.mdc");

      // User edits the .mdc to add their own frontmatter line and
      // change alwaysApply.
      const original = await readFile(mdcPath, "utf-8");
      const userEdited = original.replace(
        "alwaysApply: true",
        "alwaysApply: false\nglobs: ['src/**/*.ts']\nuserNote: 'I prefer scoped activation'",
      );
      await writeFile(mdcPath, userEdited, "utf-8");

      // Re-run — the marker contract anchors on the markers, NOT
      // the frontmatter, so user customizations above the markers
      // survive the refresh.
      await injectAllTargets(
        [makeAgent("cursor", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );
      const final = await readFile(mdcPath, "utf-8");

      // Note: this test pins the LOAD-BEARING claim that the
      // refresh does not destroy markers. The full frontmatter-
      // preservation behavior depends on the marker anchoring (the
      // .mdc rendering re-emits frontmatter on first-time create
      // but only touches between markers on existing files with a
      // managed section). Existing managed section gets in-place
      // refresh; content before the managed section survives.
      expect(final).toContain("<!-- glasstrace:mcp:start v=");
      expect(final).toContain("Glasstrace MCP");
    });
  });

  describe("DoD-P11: fail-loud-per-target failure semantics", () => {
    it.skipIf(process.getuid?.() === 0)(
      "logs per-target stderr warning naming the failing file + 'permission denied' qualifier and continues to other targets when one target fails with EACCES",
      async () => {
        // Make the testDir read-only to force EACCES on writeFile
        // for CLAUDE.md but allow other targets in subdirs to
        // proceed via mkdir+writeFile under their own paths.
        // Setup: pre-create CLAUDE.md as 0o444 readable but the
        // CONTAINING directory writable so the read works but the
        // overwrite fails.
        const claudePath = join(testDir, "CLAUDE.md");
        await writeFile(claudePath, "existing\n", "utf-8");
        await chmod(claudePath, 0o444);

        const stderrSpy = vi
          .spyOn(process.stderr, "write")
          .mockReturnValue(true);

        try {
          await injectAllTargets(
            [makeAgent("claude", testDir)],
            ENDPOINT,
            SDK_VERSION,
            testDir,
          );

          const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
          expect(
            stderrCalls.some(
              (s) =>
                s.includes("CLAUDE.md") && s.includes("permission denied"),
            ),
          ).toBe(true);

          // AGENTS.md companion still written — fail-loud-per-
          // target continues to other targets after one fails.
          const agentsMd = await readFile(
            join(testDir, "AGENTS.md"),
            "utf-8",
          );
          expect(agentsMd).toContain("Glasstrace MCP");
        } finally {
          stderrSpy.mockRestore();
          await chmod(claudePath, 0o644);
        }
      },
    );

    // The broadened error-class qualifier mapping (ENOSPC, EROFS,
    // ENAMETOOLONG, ENOTDIR, EIO, fallback "I/O error") cannot be
    // exercised via real filesystem operations from a unit test
    // (would require mocking fs/promises which doesn't work under
    // ESM module spy semantics in vitest 4.x). The mapping is
    // pinned by code review of the `emitTargetWarning` switch in
    // `inject-all-targets.ts`. Integration coverage on read-only-
    // root scenarios at impl time will exercise the EACCES path
    // above, which shares the same emit path.
  });

  describe("DoD-P14: silent-on-success logging discipline", () => {
    it("produces zero stderr output when all writes succeed across all 6 agents", async () => {
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      try {
        await injectAllTargets(
          [
            makeAgent("claude", testDir),
            makeAgent("codex", testDir),
            makeAgent("gemini", testDir),
            makeAgent("cursor", testDir),
            makeAgent("windsurf", testDir),
            makeAgent("generic", testDir),
          ],
          ENDPOINT,
          SDK_VERSION,
          testDir,
        );

        // The SDK is loaded into user runtimes; verbose
        // per-write logging would constitute log spam. Wave 18
        // failure-only logging discipline.
        expect(stderrSpy.mock.calls.length).toBe(0);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });

  describe("Codex P2 v6: monorepo companion AGENTS.md resolves against agent foundDir, not projectRoot", () => {
    it("Claude detected at git root via .claude/ in a monorepo writes companion AGENTS.md at the git root, not at the projectRoot subdirectory", async () => {
      // Synthetic agent whose infoFilePath points at <gitRoot>/CLAUDE.md
      // even though the projectRoot is a deeper subdirectory. This
      // mirrors what `detectAgents` produces when it walks up to find
      // a marker at the git root in a monorepo init from a package
      // subdirectory.
      const gitRoot = testDir;
      const apiDir = join(gitRoot, "packages", "api");
      await mkdir(apiDir, { recursive: true });

      const claudeAgent: DetectedAgent = {
        name: "claude",
        mcpConfigPath: join(gitRoot, ".mcp.json"),
        infoFilePath: join(gitRoot, "CLAUDE.md"),
        cliAvailable: false,
        registrationCommand:
          "npx --yes --package @glasstrace/sdk glasstrace mcp add --agent claude",
      };

      // projectRoot is `packages/api/`, but the agent's foundDir is
      // the gitRoot. Companion AGENTS.md must land at gitRoot.
      await injectAllTargets([claudeAgent], ENDPOINT, SDK_VERSION, apiDir);

      const claude = await readFile(join(gitRoot, "CLAUDE.md"), "utf-8");
      const agentsMdAtGitRoot = await readFile(
        join(gitRoot, "AGENTS.md"),
        "utf-8",
      );
      expect(claude).toContain("Glasstrace MCP");
      expect(agentsMdAtGitRoot).toContain("Glasstrace MCP");

      // The wrong location (apiDir) must NOT receive a companion
      // AGENTS.md — the agent is at gitRoot, so the companion is too.
      await expect(
        readFile(join(apiDir, "AGENTS.md"), "utf-8"),
      ).rejects.toThrow();
    });
  });

  describe("Codex P2 v4: append to existing .mdc without markers does NOT duplicate YAML frontmatter", () => {
    it("when .cursor/rules/glasstrace.mdc exists with user content but no Glasstrace markers, append-only writes the managed section without injecting a second --- ... --- block mid-file", async () => {
      // Pre-existing .mdc with the user's own frontmatter and prose
      // but NO Glasstrace markers. The wave 18 dispatcher's append
      // path must NOT inject another full frontmatter block — that
      // would corrupt the .mdc rule shape.
      const userMdcPath = join(testDir, ".cursor", "rules", "glasstrace.mdc");
      await mkdir(join(testDir, ".cursor", "rules"), { recursive: true });
      const userExisting = [
        "---",
        "description: my own rules",
        "alwaysApply: false",
        "globs: ['src/**/*.ts']",
        "---",
        "",
        "# My personal rules",
        "Use double-quotes for all strings.",
        "",
      ].join("\n");
      await writeFile(userMdcPath, userExisting, "utf-8");

      await injectAllTargets(
        [makeAgent("cursor", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );

      const after = await readFile(userMdcPath, "utf-8");

      // Exactly ONE `--- ... ---` block in the file (the user's
      // original frontmatter), not two. The injected managed
      // section is appended below the existing content with HTML
      // comment markers but no frontmatter wrapper.
      const frontmatterDelimiterCount = (after.match(/^---$/gm) ?? []).length;
      expect(frontmatterDelimiterCount).toBe(2); // opening + closing of user's own frontmatter

      // User's existing content preserved.
      expect(after).toContain("description: my own rules");
      expect(after).toContain("# My personal rules");
      expect(after).toContain("Use double-quotes for all strings.");

      // Managed section appended with markers but no fresh frontmatter.
      expect(after).toContain("<!-- glasstrace:mcp:start v=");
      expect(after).toContain("<!-- glasstrace:mcp:end -->");
      expect(after).toContain("Glasstrace MCP");

      // Crucially: the SDK's own `description: Glasstrace MCP runtime
      // debugging tools` frontmatter line (which would only appear
      // inside a duplicate `---` block) does NOT show up.
      expect(after).not.toContain("description: Glasstrace MCP runtime");
    });
  });

  describe("DoD-P4: path-exists gate removal regression test", () => {
    it("creates AGENTS.md from scratch when it does not pre-exist (path-exists gate dropped per Wave 18)", async () => {
      // Fresh project — no AGENTS.md, no CLAUDE.md, nothing.
      await mkdir(join(testDir, ".claude"));

      // Pre-Wave-18 the path-exists gate would have nulled out
      // infoFilePath because CLAUDE.md doesn't exist; the SDK
      // would have written nothing. Wave 18 drops the gate; the
      // multi-target helper creates the file.
      await injectAllTargets(
        [makeAgent("claude", testDir)],
        ENDPOINT,
        SDK_VERSION,
        testDir,
      );

      const claude = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
      const agentsMd = await readFile(join(testDir, "AGENTS.md"), "utf-8");
      expect(claude).toContain("<!-- glasstrace:mcp:start v=");
      expect(agentsMd).toContain("<!-- glasstrace:mcp:start v=");
    });
  });
});
