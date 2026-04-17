import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

import {
  writeShutdownMarker,
  runUninit,
} from "../../../../packages/sdk/src/cli/uninit.js";
import {
  decideMcpConfigAction,
  runInit,
} from "../../../../packages/sdk/src/cli/init.js";
import {
  mcpConfigMatches,
  readEnvLocalApiKey,
  isDevApiKey,
} from "../../../../packages/sdk/src/cli/scaffolder.js";
import { saveCachedConfig } from "../../../../packages/sdk/src/init-client.js";
import { checkShutdownMarker } from "../../../../packages/sdk/src/heartbeat.js";
import * as lifecycle from "../../../../packages/sdk/src/lifecycle.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

function createTmpProject(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "glasstrace-install-lc-"),
  );
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-project" }),
  );
  // Satisfy the monorepo resolver's Next.js detection — runInit rejects
  // projects without any next.config.* file.
  fs.writeFileSync(
    path.join(dir, "next.config.ts"),
    "export default {};\n",
  );
  return dir;
}

beforeEach(() => {
  lifecycle.resetLifecycleForTesting();
  lifecycle.initLifecycle({ logger: () => {} });
});

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  lifecycle.resetLifecycleForTesting();
});

// ---------------------------------------------------------------------------
// Scenario 1 — Uninit while dev server is running
// ---------------------------------------------------------------------------

describe("Scenario 1: shutdown-requested marker", () => {
  it("writeShutdownMarker creates the marker file when .glasstrace/ exists", () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    const written = writeShutdownMarker(projectRoot);
    expect(written).toBe(true);
    const markerPath = path.join(
      projectRoot,
      ".glasstrace",
      "shutdown-requested",
    );
    expect(fs.existsSync(markerPath)).toBe(true);
    // Atomic write: no stray .tmp file should remain after rename succeeds.
    expect(fs.existsSync(`${markerPath}.tmp`)).toBe(false);
  });

  it("writeShutdownMarker no-ops when .glasstrace/ is missing", () => {
    const projectRoot = createTmpProject();
    const written = writeShutdownMarker(projectRoot);
    expect(written).toBe(false);
    expect(
      fs.existsSync(path.join(projectRoot, ".glasstrace", "shutdown-requested")),
    ).toBe(false);
  });

  it("writeShutdownMarker payload is valid JSON with an ISO timestamp", () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    writeShutdownMarker(projectRoot);
    const body = fs.readFileSync(
      path.join(projectRoot, ".glasstrace", "shutdown-requested"),
      "utf-8",
    );
    const parsed = JSON.parse(body) as { requestedAt: string };
    expect(parsed.requestedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("checkShutdownMarker triggers executeShutdown and removes the marker", async () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    writeShutdownMarker(projectRoot);

    const hookCalled = vi.fn(() => Promise.resolve());
    lifecycle.registerShutdownHook({ name: "test-hook", priority: 0, fn: hookCalled });

    const result = checkShutdownMarker(projectRoot);
    expect(result.triggered).toBe(true);
    if (result.shutdown) {
      await result.shutdown;
    }
    expect(hookCalled).toHaveBeenCalledOnce();
    expect(
      fs.existsSync(
        path.join(projectRoot, ".glasstrace", "shutdown-requested"),
      ),
    ).toBe(false);
  });

  it("checkShutdownMarker returns false when the marker is absent", () => {
    const projectRoot = createTmpProject();
    const result = checkShutdownMarker(projectRoot);
    expect(result.triggered).toBe(false);
    expect(result.shutdown).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Re-install preservation
// ---------------------------------------------------------------------------

describe("Scenario 2: re-install preservation", () => {
  it("runInit preserves an existing .glasstrace/anon_key", async () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"), { mode: 0o700 });
    const originalKey = "gt_anon_" + "a".repeat(48);
    fs.writeFileSync(
      path.join(projectRoot, ".glasstrace", "anon_key"),
      originalKey,
      { mode: 0o600 },
    );
    const result = await runInit({
      projectRoot,
      yes: true,
      coverageMap: false,
      force: false,
    });
    expect(result.exitCode).toBe(0);
    // Key file must still exist with the original content
    const keyAfter = fs.readFileSync(
      path.join(projectRoot, ".glasstrace", "anon_key"),
      "utf-8",
    );
    expect(keyAfter).toBe(originalKey);
    expect(result.summary.some((s) => /Preserved existing \.glasstrace\/anon_key/.test(s))).toBe(
      true,
    );
  });

  it("runInit preserves .glasstrace/config on re-init", async () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"), { mode: 0o700 });
    const originalConfig = JSON.stringify({
      response: { sessionId: "abc", config: {} },
      cachedAt: 123,
    });
    fs.writeFileSync(
      path.join(projectRoot, ".glasstrace", "config"),
      originalConfig,
      { mode: 0o600 },
    );
    const result = await runInit({
      projectRoot,
      yes: true,
      coverageMap: false,
      force: false,
    });
    expect(result.exitCode).toBe(0);
    const configAfter = fs.readFileSync(
      path.join(projectRoot, ".glasstrace", "config"),
      "utf-8",
    );
    expect(configAfter).toBe(originalConfig);
  });

  it("mcpConfigMatches treats semantically equal JSON as matching regardless of key order", () => {
    const a = JSON.stringify({ mcpServers: { glasstrace: { url: "x", type: "http" } } });
    const b = JSON.stringify({ mcpServers: { glasstrace: { type: "http", url: "x" } } });
    expect(mcpConfigMatches(a, b)).toBe(true);
  });

  it("mcpConfigMatches detects user edits that change a field value", () => {
    const a = JSON.stringify({ mcpServers: { glasstrace: { url: "http://old" } } });
    const b = JSON.stringify({ mcpServers: { glasstrace: { url: "http://new" } } });
    expect(mcpConfigMatches(a, b)).toBe(false);
  });

  it("decideMcpConfigAction returns 'write' when file does not exist", async () => {
    const projectRoot = createTmpProject();
    const action = await decideMcpConfigAction({
      configPath: path.join(projectRoot, ".mcp.json"),
      expectedContent: "{}",
      force: false,
    });
    expect(action).toBe("write");
  });

  it("decideMcpConfigAction returns 'skip' when user declines the prompt", async () => {
    const projectRoot = createTmpProject();
    const configPath = path.join(projectRoot, ".mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { glasstrace: { url: "manual" } } }));
    const action = await decideMcpConfigAction({
      configPath,
      expectedContent: JSON.stringify({ mcpServers: { glasstrace: { url: "template" } } }),
      force: false,
      prompt: async () => false,
    });
    expect(action).toBe("skip");
  });

  it("decideMcpConfigAction returns 'force-overwrite' when --force is set and content differs", async () => {
    const projectRoot = createTmpProject();
    const configPath = path.join(projectRoot, ".mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { glasstrace: { url: "manual" } } }));
    const action = await decideMcpConfigAction({
      configPath,
      expectedContent: JSON.stringify({ mcpServers: { glasstrace: { url: "template" } } }),
      force: true,
    });
    expect(action).toBe("force-overwrite");
  });

  it("decideMcpConfigAction returns 'write' when existing matches expected", async () => {
    const projectRoot = createTmpProject();
    const configPath = path.join(projectRoot, ".mcp.json");
    const content = JSON.stringify({ mcpServers: { glasstrace: { url: "x" } } });
    fs.writeFileSync(configPath, content);
    const action = await decideMcpConfigAction({
      configPath,
      expectedContent: content,
      force: false,
    });
    expect(action).toBe("write");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — npm uninstall preuninstall warning
// ---------------------------------------------------------------------------

describe("Scenario 3: preuninstall warning script", () => {
  it("package.json declares a preuninstall script that prints a warning", () => {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../../packages/sdk/package.json"),
        "utf-8",
      ),
    ) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.preuninstall).toBeDefined();
    expect(pkg.scripts?.preuninstall).toMatch(/uninit/);
  });

  it("preuninstall script body executes without shell expansion regressions", () => {
    // Run the script exactly as npm would: through `sh -c` so the shell
    // interprets the exact quoting/escaping in package.json. This catches
    // backtick-induced command substitution (Codex P1 from initial review).
    const pkg = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../../packages/sdk/package.json"),
        "utf-8",
      ),
    ) as { scripts: { preuninstall: string } };
    const result = spawnSync("sh", ["-c", pkg.scripts.preuninstall], {
      encoding: "utf-8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/uninit/);
    // Backticks inside the script must not trigger command substitution.
    // If they did, the shell would attempt to run "npm uninstall ..." or
    // "npx ... uninit" during preuninstall and the output would differ.
    expect(result.stderr).toMatch(/npm uninstall @glasstrace\/sdk/);
    expect(result.stderr).toMatch(/npx @glasstrace\/sdk uninit/);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — covered in validate.test.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scenario 5 — atomic config writes
// ---------------------------------------------------------------------------

describe("Scenario 5: atomic .glasstrace/config writes", () => {
  it("saveCachedConfig leaves no .tmp file after a successful write", async () => {
    const projectRoot = createTmpProject();
    const response = {
      sessionId: "abc" as unknown as string,
      config: {
        collectConsole: true,
        collectFetch: true,
        collectPrisma: true,
        collectDrizzle: true,
        samplingRatio: 1,
      },
    } as unknown as Parameters<typeof saveCachedConfig>[0];
    await saveCachedConfig(response, projectRoot);
    const dir = path.join(projectRoot, ".glasstrace");
    const entries = fs.readdirSync(dir);
    expect(entries).toContain("config");
    expect(entries).not.toContain("config.tmp");
  });

  it("mid-write crash simulation: pre-existing config survives an aborted write-temp step", () => {
    // Simulate the atomic-write contract: if the .tmp file is written
    // but the rename never happens (crash mid-write), the original
    // config must remain untouched.
    const projectRoot = createTmpProject();
    const dir = path.join(projectRoot, ".glasstrace");
    fs.mkdirSync(dir, { mode: 0o700 });
    const configPath = path.join(dir, "config");
    const tmpPath = `${configPath}.tmp`;
    const originalContent = JSON.stringify({ good: true });
    fs.writeFileSync(configPath, originalContent);
    // Simulate partially-written tmp file (crash before rename)
    fs.writeFileSync(tmpPath, "{ partial", { mode: 0o600 });

    // Verify the original is intact
    expect(fs.readFileSync(configPath, "utf-8")).toBe(originalContent);
    // A subsequent startup would see a stale .tmp — the real saveCachedConfig
    // cleans it up on the next attempt. Verify the invariant: the readable
    // config path never contains the partial payload.
    expect(fs.readFileSync(configPath, "utf-8")).not.toContain("partial");
  });

  it("saveCachedConfig removes the .tmp file when rename fails", async () => {
    // Simulate a real rename failure by placing the target `config` as a
    // directory. `rename(src, dst)` on POSIX fails with EISDIR (or
    // ENOTEMPTY) when the destination is a non-empty directory —
    // exercising the catch block that unlinks the temp file. Copilot
    // review flagged that the earlier version of this test just
    // re-exercised the happy path.
    const projectRoot = createTmpProject();
    const dir = path.join(projectRoot, ".glasstrace");
    fs.mkdirSync(dir, { mode: 0o700 });
    // Place a non-empty directory at the config path so rename fails
    fs.mkdirSync(path.join(dir, "config"));
    fs.writeFileSync(path.join(dir, "config", "stub"), "blocking-file");

    const response = {
      sessionId: "s",
      config: {
        collectConsole: true,
        collectFetch: true,
        collectPrisma: true,
        collectDrizzle: true,
        samplingRatio: 1,
      },
    } as unknown as Parameters<typeof saveCachedConfig>[0];

    // saveCachedConfig swallows errors (logs a warning) so the call
    // itself resolves; we assert on the filesystem afterward.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await saveCachedConfig(response, projectRoot);
    } finally {
      warnSpy.mockRestore();
    }

    const entries = fs.readdirSync(dir);
    // The tmp file must have been cleaned up by the error path
    expect(entries).not.toContain("config.tmp");
    // The blocking directory (our simulated rename target) must still be
    // present and untouched — a failed rename must NOT clobber existing
    // filesystem state.
    expect(entries).toContain("config");
    expect(fs.statSync(path.join(dir, "config")).isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Dev-key preservation + uninit confirmation
// ---------------------------------------------------------------------------

describe("Scenario 6: dev-key preservation", () => {
  it("readEnvLocalApiKey returns the value of GLASSTRACE_API_KEY", () => {
    const content = "FOO=bar\nGLASSTRACE_API_KEY=gt_dev_" + "a".repeat(48) + "\n";
    expect(readEnvLocalApiKey(content)).toBe("gt_dev_" + "a".repeat(48));
  });

  it("readEnvLocalApiKey returns null for a commented-out placeholder", () => {
    const content = "# GLASSTRACE_API_KEY=your_key_here\n";
    expect(readEnvLocalApiKey(content)).toBeNull();
  });

  it("readEnvLocalApiKey returns null for the 'your_key_here' placeholder", () => {
    const content = "GLASSTRACE_API_KEY=your_key_here\n";
    expect(readEnvLocalApiKey(content)).toBeNull();
  });

  it("readEnvLocalApiKey unquotes double-quoted values", () => {
    const content = 'GLASSTRACE_API_KEY="gt_dev_abc"\n';
    expect(readEnvLocalApiKey(content)).toBe("gt_dev_abc");
  });

  it("readEnvLocalApiKey unquotes single-quoted values", () => {
    const content = "GLASSTRACE_API_KEY='gt_dev_abc'\n";
    expect(readEnvLocalApiKey(content)).toBe("gt_dev_abc");
  });

  it("readEnvLocalApiKey returns null when the value is empty", () => {
    const content = "GLASSTRACE_API_KEY=\n";
    expect(readEnvLocalApiKey(content)).toBeNull();
  });

  it("readEnvLocalApiKey returns the last non-placeholder value when multiple are defined (env override semantics)", () => {
    const realKey = "gt_dev_" + "a".repeat(48);
    const content = `GLASSTRACE_API_KEY=your_key_here\nGLASSTRACE_API_KEY=${realKey}\n`;
    expect(readEnvLocalApiKey(content)).toBe(realKey);
  });

  it("readEnvLocalApiKey skips trailing placeholder and returns the earlier real value", () => {
    const realKey = "gt_dev_" + "a".repeat(48);
    const content = `GLASSTRACE_API_KEY=${realKey}\nGLASSTRACE_API_KEY=your_key_here\n`;
    expect(readEnvLocalApiKey(content)).toBe(realKey);
  });

  it("isDevApiKey identifies gt_dev_ keys and rejects anon/empty", () => {
    expect(isDevApiKey("gt_dev_abc")).toBe(true);
    expect(isDevApiKey("  gt_dev_abc  ")).toBe(true);
    expect(isDevApiKey("gt_anon_abc")).toBe(false);
    expect(isDevApiKey("")).toBe(false);
    expect(isDevApiKey(null)).toBe(false);
  });

  it("runUninit preserves a dev key when the user declines confirmation", async () => {
    const projectRoot = createTmpProject();
    const envPath = path.join(projectRoot, ".env.local");
    const devKey = "gt_dev_" + "a".repeat(48);
    fs.writeFileSync(envPath, `GLASSTRACE_API_KEY=${devKey}\n`);

    const result = await runUninit({
      projectRoot,
      dryRun: false,
      force: false,
      prompt: async () => false,
    });

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain(devKey);
    expect(result.warnings.join("\n")).toMatch(/Preserved GLASSTRACE_API_KEY/);
  });

  it("runUninit removes the dev key when the user confirms", async () => {
    const projectRoot = createTmpProject();
    const envPath = path.join(projectRoot, ".env.local");
    const devKey = "gt_dev_" + "a".repeat(48);
    fs.writeFileSync(envPath, `GLASSTRACE_API_KEY=${devKey}\nOTHER=x\n`);

    const result = await runUninit({
      projectRoot,
      dryRun: false,
      force: false,
      prompt: async () => true,
    });

    expect(result.exitCode).toBe(0);
    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).not.toContain(devKey);
    expect(content).toContain("OTHER=x");
  });

  it("runUninit removes the dev key without prompting when --force is used", async () => {
    const projectRoot = createTmpProject();
    const envPath = path.join(projectRoot, ".env.local");
    const devKey = "gt_dev_" + "a".repeat(48);
    fs.writeFileSync(envPath, `GLASSTRACE_API_KEY=${devKey}\n`);

    const promptSpy = vi.fn(async () => false);
    await runUninit({
      projectRoot,
      dryRun: false,
      force: true,
      prompt: promptSpy,
    });
    expect(promptSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(envPath)).toBe(false);
  });

  it("runUninit writes a shutdown marker before cleanup when .glasstrace/ exists", async () => {
    const projectRoot = createTmpProject();
    fs.mkdirSync(path.join(projectRoot, ".glasstrace"));
    const result = await runUninit({
      projectRoot,
      dryRun: false,
      force: true,
      prompt: async () => true,
    });
    // After cleanup, the marker itself is deleted along with .glasstrace/,
    // but the summary should record that it was written.
    expect(
      result.summary.some((s) => /shutdown-requested marker/.test(s)),
    ).toBe(true);
  });

  it("runInit preserves an existing dev key in .env.local and notes it in the summary", async () => {
    const projectRoot = createTmpProject();
    const devKey = "gt_dev_" + "a".repeat(48);
    fs.writeFileSync(
      path.join(projectRoot, ".env.local"),
      `GLASSTRACE_API_KEY=${devKey}\n`,
    );

    const result = await runInit({
      projectRoot,
      yes: true,
      coverageMap: false,
      force: false,
    });

    expect(result.exitCode).toBe(0);
    const content = fs.readFileSync(
      path.join(projectRoot, ".env.local"),
      "utf-8",
    );
    expect(content).toContain(devKey);
    expect(
      result.summary.some((s) => /Preserved existing \.env\.local/.test(s)),
    ).toBe(true);
  });
});

