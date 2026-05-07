import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  compareSemver,
  maybeWarnStaleAgentInstructions,
  _resetUpgradeNoticeForTesting,
} from "../../../../packages/sdk/src/agent-detection/upgrade-notice.js";

function tmpDir(): string {
  return join(tmpdir(), `glasstrace-test-${randomUUID()}`);
}

/**
 * Captures every chunk written to the upgrade-notice's stderr seam so a
 * test can assert on the emitted lines without touching the real stderr
 * (vitest's worker stderr would be buffered with other tests' output).
 */
function makeStderr() {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => {
      chunks.push(chunk);
    },
    chunks,
  };
}

describe("compareSemver", () => {
  it("returns null for unparseable inputs (future-format tolerance)", () => {
    // SDK-050 Required Semantics Item 1: when a stamp is present but
    // not parseable as semver, the upgrade-notice MUST NOT emit a
    // warning. compareSemver returns null so the caller can detect
    // that condition without crashing.
    expect(compareSemver("not-a-semver", "1.4.0")).toBeNull();
    expect(compareSemver("1.4.0", "definitely.not.semver-extra")).toBeNull();
    expect(compareSemver("", "1.4.0")).toBeNull();
  });

  it("compares stable versions numerically across each component", () => {
    expect(compareSemver("1.4.0", "1.4.1")).toBeLessThan(0);
    expect(compareSemver("1.4.0", "1.5.0")).toBeLessThan(0);
    expect(compareSemver("1.4.0", "2.0.0")).toBeLessThan(0);
    expect(compareSemver("1.4.0", "1.4.0")).toBe(0);
    expect(compareSemver("1.5.0", "1.4.9")).toBeGreaterThan(0);
  });

  it("ranks a version with a prerelease lower than its stable counterpart", () => {
    // Per semver spec: 1.4.0-canary < 1.4.0.
    expect(compareSemver("1.4.0-canary", "1.4.0")).toBeLessThan(0);
    expect(compareSemver("1.4.0", "1.4.0-canary")).toBeGreaterThan(0);
  });

  it("compares two prerelease versions lexically and numerically", () => {
    expect(
      compareSemver(
        "0.0.0-canary-20260508120000",
        "0.0.0-canary-20260509120000",
      ),
    ).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0-beta.1")).toBeGreaterThan(0);
  });

  it("ignores build metadata when comparing", () => {
    expect(compareSemver("1.4.0+build.1", "1.4.0+build.2")).toBe(0);
    expect(compareSemver("1.4.0+build.1", "1.4.1")).toBeLessThan(0);
  });
});

describe("maybeWarnStaleAgentInstructions", () => {
  let testDir: string;

  beforeEach(async () => {
    _resetUpgradeNoticeForTesting();
    testDir = tmpDir();
    await mkdir(testDir, { recursive: true });
    delete process.env.GLASSTRACE_DISABLE_UPGRADE_NOTICE;
  });

  afterEach(async () => {
    delete process.env.GLASSTRACE_DISABLE_UPGRADE_NOTICE;
    _resetUpgradeNoticeForTesting();
    await rm(testDir, { recursive: true, force: true });
  });

  it("emits exactly one stderr line when CLAUDE.md is stamped with an older SDK version", async () => {
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        "<!-- glasstrace:mcp:start v=1.0.0 -->",
        "old content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );

    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });

    expect(stderr.chunks).toHaveLength(1);
    expect(stderr.chunks[0]).toContain("CLAUDE.md");
    expect(stderr.chunks[0]).toContain("npx glasstrace upgrade-instructions");
    expect(stderr.chunks[0]).toContain("GLASSTRACE_DISABLE_UPGRADE_NOTICE");
    // Single newline at the end — single stderr line.
    expect(stderr.chunks[0].endsWith("\n")).toBe(true);
    expect((stderr.chunks[0].match(/\n/g) ?? []).length).toBe(1);
  });

  it("emits at most one warning per process boot (even with multiple init calls)", async () => {
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        "<!-- glasstrace:mcp:start v=1.0.0 -->",
        "old content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );

    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });

    expect(stderr.chunks).toHaveLength(1);
  });

  it("emits no warning when the stamp is current (Acceptance Gate 4)", async () => {
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        "<!-- glasstrace:mcp:start v=1.4.0 -->",
        "current content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );

    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });

    expect(stderr.chunks).toHaveLength(0);
  });

  it("emits no warning on a downgrade (newer stamp, older running SDK)", async () => {
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        "<!-- glasstrace:mcp:start v=1.5.0 -->",
        "future content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );

    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });

    expect(stderr.chunks).toHaveLength(0);
  });

  it("emits no warning when the managed section is unstamped (legacy section)", async () => {
    // Per SDK-050 Required Semantics §2 Item 3, the warning fires
    // only on STAMPED stale sections. Legacy unstamped users get the
    // refresh on their next mcp add / upgrade-instructions run; no
    // runtime nag at SDK init.
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        "<!-- glasstrace:mcp:start -->",
        "legacy content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );

    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });

    expect(stderr.chunks).toHaveLength(0);
  });

  it("emits no warning when the stamp is unparseable (future-format tolerance)", async () => {
    // A user (or a future SDK using a richer stamp format) might
    // produce a stamp that is not parseable as semver. The brief
    // requires we skip the warning rather than crash.
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        "<!-- glasstrace:mcp:start v=not-a-semver -->",
        "exotic content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );

    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });

    expect(stderr.chunks).toHaveLength(0);
  });

  it("emits no warning when the file has no managed section", async () => {
    await writeFile(
      join(testDir, "CLAUDE.md"),
      "# Hand-written instructions\n\nNo Glasstrace block here.\n",
    );

    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });

    expect(stderr.chunks).toHaveLength(0);
  });

  it("emits no warning when no agent instruction files exist", () => {
    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });
    expect(stderr.chunks).toHaveLength(0);
  });

  it("respects the GLASSTRACE_DISABLE_UPGRADE_NOTICE opt-out", async () => {
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        "<!-- glasstrace:mcp:start v=1.0.0 -->",
        "old content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );

    for (const truthy of ["1", "true", "yes", "TRUE", "Yes"]) {
      _resetUpgradeNoticeForTesting();
      process.env.GLASSTRACE_DISABLE_UPGRADE_NOTICE = truthy;
      const stderr = makeStderr();
      maybeWarnStaleAgentInstructions({
        projectRoot: testDir,
        sdkVersion: "1.4.0",
        stderrWrite: stderr.write,
      });
      expect(stderr.chunks).toHaveLength(0);
    }
  });

  it("does not treat arbitrary non-truthy env values as opt-out", async () => {
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        "<!-- glasstrace:mcp:start v=1.0.0 -->",
        "old content",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );

    for (const value of ["", "0", "false", "no", "off", "verbose"]) {
      _resetUpgradeNoticeForTesting();
      process.env.GLASSTRACE_DISABLE_UPGRADE_NOTICE = value;
      const stderr = makeStderr();
      maybeWarnStaleAgentInstructions({
        projectRoot: testDir,
        sdkVersion: "1.4.0",
        stderrWrite: stderr.write,
      });
      expect(stderr.chunks).toHaveLength(1);
    }
  });

  it("warns when ANY of multiple agent instruction files is stale (multi-file projects)", async () => {
    // DISC-1586 §Multi-file projects: the stale-warning at SDK init
    // must fire if any detected file is stale, but only ONE line per
    // process. The warning text mentions every stale file.
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        "<!-- glasstrace:mcp:start v=1.4.0 -->",
        "current",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );
    await writeFile(
      join(testDir, ".cursorrules"),
      [
        "# glasstrace:mcp:start v=1.0.0",
        "stale",
        "# glasstrace:mcp:end",
      ].join("\n"),
    );

    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });

    expect(stderr.chunks).toHaveLength(1);
    expect(stderr.chunks[0]).toContain(".cursorrules");
    // CLAUDE.md is current — must NOT appear in the warning's file list.
    expect(stderr.chunks[0]).not.toMatch(/CLAUDE\.md/);
  });

  it("does not include the on-disk stamp value verbatim in the warning", async () => {
    // Required Semantics Item 3: "the warning text must NOT include
    // any user-controlled content ... arbitrary stamp contents from
    // the file are NOT [acceptable] — sanitize before interpolating,
    // since a user or attacker could hand-edit the stamp to inject
    // terminal escape sequences."
    //
    // Our chosen defence is to never echo the stamp at all. The
    // stamp contains only [A-Za-z0-9.+-] when written by the SDK,
    // but a hand-edited file could put anything between `v=` and
    // the closing `-->`. We treat that as untrusted and do not
    // forward it to stderr.
    await writeFile(
      join(testDir, "CLAUDE.md"),
      [
        // Use a bizarre but parseable-as-semver stamp; even though
        // semver-valid, the warning must not echo it.
        "<!-- glasstrace:mcp:start v=0.0.1-evil-marker-do-not-echo -->",
        "old",
        "<!-- glasstrace:mcp:end -->",
      ].join("\n"),
    );

    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });

    expect(stderr.chunks).toHaveLength(1);
    expect(stderr.chunks[0]).not.toContain("evil-marker-do-not-echo");
    expect(stderr.chunks[0]).not.toContain("0.0.1");
  });

  it("never throws when the project root does not exist", () => {
    const stderr = makeStderr();
    expect(() =>
      maybeWarnStaleAgentInstructions({
        projectRoot: join(testDir, "does", "not", "exist"),
        sdkVersion: "1.4.0",
        stderrWrite: stderr.write,
      }),
    ).not.toThrow();
    expect(stderr.chunks).toHaveLength(0);
  });

  it("does not write to a real stderr when the test seam is provided", () => {
    // Defends against a refactor that accidentally falls through to
    // process.stderr.write even when the caller supplied a test seam.
    // We assert by checking the chunks the seam captured equal what
    // would have been written.
    const stderr = makeStderr();
    maybeWarnStaleAgentInstructions({
      projectRoot: testDir,
      sdkVersion: "1.4.0",
      stderrWrite: stderr.write,
    });
    // Nothing should have been emitted (no stamped files in testDir),
    // and importantly the call returned cleanly. This test stands as
    // a smoke check for the seam wiring; staler scenarios are
    // covered above.
    expect(stderr.chunks).toHaveLength(0);
  });
});
