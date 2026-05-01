import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  isAnonApiKey,
  resolveEffectiveMcpCredential,
  readMcpMarker,
  writeMcpMarker,
  identityFingerprint,
  refreshGenericMcpConfigAtRuntime,
  __resetRefreshNudgeForTest,
  MCP_ENDPOINT,
} from "../../../packages/sdk/src/mcp-runtime.js";
import { readClaimedKey } from "../../../packages/sdk/src/anon-key.js";
import { generateMcpConfig } from "../../../packages/sdk/src/agent-detection/configs.js";
import type { DetectedAgent } from "../../../packages/sdk/src/agent-detection/detect.js";

const VALID_ANON_KEY = "gt_anon_" + "a".repeat(48);
const VALID_DEV_KEY = "gt_dev_" + "b".repeat(48);
const ANOTHER_DEV_KEY = "gt_dev_" + "c".repeat(48);

function makeTmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-runtime-test-"));
  return dir;
}

function writeAnonKey(root: string, key = VALID_ANON_KEY): void {
  const dir = path.join(root, ".glasstrace");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "anon_key"), key, { mode: 0o600 });
}

function writeClaimedKeyFile(root: string, key = VALID_DEV_KEY): void {
  const dir = path.join(root, ".glasstrace");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "claimed-key"), key, { mode: 0o600 });
}

function writeEnvLocal(root: string, body: string): void {
  fs.writeFileSync(path.join(root, ".env.local"), body, { mode: 0o600 });
}

describe("isAnonApiKey", () => {
  it("returns true for a fully valid anon key", () => {
    expect(isAnonApiKey(VALID_ANON_KEY)).toBe(true);
  });

  it("returns false for prefix-only matches that fail the schema", () => {
    expect(isAnonApiKey("gt_anon_short")).toBe(false);
    expect(isAnonApiKey("gt_anon_" + "Z".repeat(48))).toBe(false);
  });

  it("returns false for a dev key", () => {
    expect(isAnonApiKey(VALID_DEV_KEY)).toBe(false);
  });

  it("returns false for null, undefined, empty", () => {
    expect(isAnonApiKey(null)).toBe(false);
    expect(isAnonApiKey(undefined)).toBe(false);
    expect(isAnonApiKey("")).toBe(false);
  });
});

describe("resolveEffectiveMcpCredential", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null effective when no source has a key", async () => {
    const result = await resolveEffectiveMcpCredential(tmpDir);
    expect(result.effective).toBeNull();
    expect(result.anonKey).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it("prefers .env.local dev key over claimed-key and anon", async () => {
    writeEnvLocal(tmpDir, `GLASSTRACE_API_KEY=${VALID_DEV_KEY}\n`);
    writeClaimedKeyFile(tmpDir, ANOTHER_DEV_KEY);
    writeAnonKey(tmpDir);

    const result = await resolveEffectiveMcpCredential(tmpDir);
    expect(result.effective).toEqual({
      source: "env-local",
      key: VALID_DEV_KEY,
    });
    expect(result.anonKey).toBe(VALID_ANON_KEY);
    expect(result.warnings).toEqual([]);
  });

  it("falls through to claimed-key when env-local has no dev key", async () => {
    writeClaimedKeyFile(tmpDir);
    writeAnonKey(tmpDir);

    const result = await resolveEffectiveMcpCredential(tmpDir);
    expect(result.effective).toEqual({
      source: "claimed-key",
      key: VALID_DEV_KEY,
    });
    expect(result.warnings).toContain("claimed-key-only");
  });

  it("falls through to anon when no dev source is present", async () => {
    writeAnonKey(tmpDir);

    const result = await resolveEffectiveMcpCredential(tmpDir);
    expect(result.effective).toEqual({
      source: "anon",
      key: VALID_ANON_KEY,
    });
    expect(result.warnings).toEqual([]);
  });

  it("emits malformed-env-local warning when GLASSTRACE_API_KEY is shape-invalid", async () => {
    writeEnvLocal(tmpDir, "GLASSTRACE_API_KEY=gt_dev_short\n");
    writeAnonKey(tmpDir);

    const result = await resolveEffectiveMcpCredential(tmpDir);
    expect(result.effective).toEqual({
      source: "anon",
      key: VALID_ANON_KEY,
    });
    expect(result.warnings).toContain("malformed-env-local");
  });

  it("treats GLASSTRACE_API_KEY= (empty) as silently absent", async () => {
    writeEnvLocal(tmpDir, "GLASSTRACE_API_KEY=\n");
    writeAnonKey(tmpDir);

    const result = await resolveEffectiveMcpCredential(tmpDir);
    expect(result.effective?.source).toBe("anon");
    expect(result.warnings).not.toContain("malformed-env-local");
  });

  it("strips quotes around .env.local values", async () => {
    writeEnvLocal(tmpDir, `GLASSTRACE_API_KEY="${VALID_DEV_KEY}"\n`);

    const result = await resolveEffectiveMcpCredential(tmpDir);
    expect(result.effective?.source).toBe("env-local");
  });

  it("returns dev-key effective even when no anon is present", async () => {
    writeEnvLocal(tmpDir, `GLASSTRACE_API_KEY=${VALID_DEV_KEY}\n`);

    const result = await resolveEffectiveMcpCredential(tmpDir);
    expect(result.effective?.source).toBe("env-local");
    expect(result.anonKey).toBeNull();
  });
});

describe("readClaimedKey", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file is absent", async () => {
    expect(await readClaimedKey(tmpDir)).toBeNull();
  });

  it("returns the validated key when content matches DevApiKeySchema", async () => {
    writeClaimedKeyFile(tmpDir);
    expect(await readClaimedKey(tmpDir)).toBe(VALID_DEV_KEY);
  });

  it("trims trailing whitespace before validation", async () => {
    writeClaimedKeyFile(tmpDir, VALID_DEV_KEY + "\n");
    expect(await readClaimedKey(tmpDir)).toBe(VALID_DEV_KEY);
  });

  it("returns null when content fails strict validation", async () => {
    writeClaimedKeyFile(tmpDir, "gt_dev_short");
    expect(await readClaimedKey(tmpDir)).toBeNull();
  });

  it("returns null when content is an anon-shaped key", async () => {
    writeClaimedKeyFile(tmpDir, VALID_ANON_KEY);
    expect(await readClaimedKey(tmpDir)).toBeNull();
  });
});

describe("readMcpMarker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeMarker(body: string): void {
    const dir = path.join(tmpDir, ".glasstrace");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "mcp-connected"), body, { mode: 0o600 });
  }

  it("returns absent when the file does not exist", async () => {
    expect(await readMcpMarker(tmpDir)).toEqual({ status: "absent" });
  });

  it("interprets a v1 marker as anon source", async () => {
    const hash = identityFingerprint(VALID_ANON_KEY);
    writeMarker(JSON.stringify({ keyHash: hash, configuredAt: "2026-01-01T00:00:00Z" }));

    const state = await readMcpMarker(tmpDir);
    expect(state).toEqual({
      status: "valid",
      credentialSource: "anon",
      credentialHash: hash,
    });
  });

  it("reads a v2 marker", async () => {
    const hash = identityFingerprint(VALID_DEV_KEY);
    writeMarker(
      JSON.stringify({
        version: 2,
        credentialSource: "env-local",
        credentialHash: hash,
        configuredAt: "2026-01-01T00:00:00Z",
      }),
    );

    const state = await readMcpMarker(tmpDir);
    expect(state).toEqual({
      status: "valid",
      credentialSource: "env-local",
      credentialHash: hash,
    });
  });

  it("returns unknown-version for v3+ markers", async () => {
    writeMarker(JSON.stringify({ version: 3, foo: "bar" }));
    expect(await readMcpMarker(tmpDir)).toEqual({ status: "unknown-version" });
  });

  it("returns corrupted for invalid JSON", async () => {
    writeMarker("not json");
    expect(await readMcpMarker(tmpDir)).toEqual({ status: "corrupted" });
  });

  it("returns corrupted for v2 with bad credentialSource", async () => {
    writeMarker(
      JSON.stringify({
        version: 2,
        credentialSource: "service-account",
        credentialHash: "sha256:abc",
      }),
    );
    expect(await readMcpMarker(tmpDir)).toEqual({ status: "corrupted" });
  });

  it("returns corrupted for v1 with empty keyHash", async () => {
    writeMarker(JSON.stringify({ keyHash: "" }));
    expect(await readMcpMarker(tmpDir)).toEqual({ status: "corrupted" });
  });
});

describe("writeMcpMarker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpProject();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function readMarkerRaw(): unknown {
    return JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".glasstrace", "mcp-connected"), "utf-8"),
    );
  }

  it("creates a v2 marker with the expected fields", async () => {
    const hash = identityFingerprint(VALID_DEV_KEY);
    const wrote = await writeMcpMarker(tmpDir, {
      credentialSource: "env-local",
      credentialHash: hash,
    });

    expect(wrote).toBe(true);
    const marker = readMarkerRaw() as Record<string, unknown>;
    expect(marker["version"]).toBe(2);
    expect(marker["credentialSource"]).toBe("env-local");
    expect(marker["credentialHash"]).toBe(hash);
    expect(marker["configuredAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(marker["keyHash"]).toBeUndefined();
  });

  it("returns false when a matching v2 marker already exists", async () => {
    const hash = identityFingerprint(VALID_ANON_KEY);
    await writeMcpMarker(tmpDir, { credentialSource: "anon", credentialHash: hash });
    const second = await writeMcpMarker(tmpDir, {
      credentialSource: "anon",
      credentialHash: hash,
    });
    expect(second).toBe(false);
  });

  it("returns false when a matching v1 marker already exists", async () => {
    const hash = identityFingerprint(VALID_ANON_KEY);
    const dir = path.join(tmpDir, ".glasstrace");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, "mcp-connected"),
      JSON.stringify({ keyHash: hash, configuredAt: "2026-01-01T00:00:00Z" }),
      { mode: 0o600 },
    );

    const wrote = await writeMcpMarker(tmpDir, {
      credentialSource: "anon",
      credentialHash: hash,
    });
    expect(wrote).toBe(false);
  });

  it("overwrites a corrupted marker", async () => {
    const dir = path.join(tmpDir, ".glasstrace");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "mcp-connected"), "not json", { mode: 0o600 });

    const hash = identityFingerprint(VALID_ANON_KEY);
    const wrote = await writeMcpMarker(tmpDir, {
      credentialSource: "anon",
      credentialHash: hash,
    });
    expect(wrote).toBe(true);
    const marker = readMarkerRaw() as Record<string, unknown>;
    expect(marker["version"]).toBe(2);
  });

  it("overwrites an unknown-version marker", async () => {
    const dir = path.join(tmpDir, ".glasstrace");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, "mcp-connected"),
      JSON.stringify({ version: 99, mystery: true }),
      { mode: 0o600 },
    );

    const hash = identityFingerprint(VALID_ANON_KEY);
    const wrote = await writeMcpMarker(tmpDir, {
      credentialSource: "anon",
      credentialHash: hash,
    });
    expect(wrote).toBe(true);
  });

  it("writes a different v2 marker when credentialSource changes", async () => {
    const anonHash = identityFingerprint(VALID_ANON_KEY);
    await writeMcpMarker(tmpDir, { credentialSource: "anon", credentialHash: anonHash });

    const devHash = identityFingerprint(VALID_DEV_KEY);
    const wrote = await writeMcpMarker(tmpDir, {
      credentialSource: "env-local",
      credentialHash: devHash,
    });
    expect(wrote).toBe(true);

    const marker = readMarkerRaw() as Record<string, unknown>;
    expect(marker["credentialSource"]).toBe("env-local");
    expect(marker["credentialHash"]).toBe(devHash);
  });
});

describe("refreshGenericMcpConfigAtRuntime", () => {
  let tmpDir: string;
  let stderrOutput: string;
  let originalStderrWrite: typeof process.stderr.write;

  function genericAgent(): DetectedAgent {
    return {
      name: "generic",
      mcpConfigPath: path.join(tmpDir, ".glasstrace", "mcp.json"),
      infoFilePath: null,
      cliAvailable: false,
      registrationCommand: null,
    };
  }

  beforeEach(() => {
    tmpDir = makeTmpProject();
    __resetRefreshNudgeForTest();
    stderrOutput = "";
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    // Capture stderr to assert nudges and (more importantly) raw-key absence.
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalStderrWrite;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeManagedConfig(bearer: string): void {
    const dir = path.join(tmpDir, ".glasstrace");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      generateMcpConfig(genericAgent(), MCP_ENDPOINT, bearer),
      { mode: 0o600 },
    );
  }

  it("returns skipped-anon-source when effective is null", async () => {
    writeAnonKey(tmpDir);
    const result = await refreshGenericMcpConfigAtRuntime(tmpDir, null, VALID_ANON_KEY as never);
    expect(result.action).toBe("skipped-anon-source");
  });

  it("returns skipped-anon-source when effective.source === 'anon'", async () => {
    writeAnonKey(tmpDir);
    writeManagedConfig(VALID_ANON_KEY);
    const result = await refreshGenericMcpConfigAtRuntime(
      tmpDir,
      { source: "anon", key: VALID_ANON_KEY as never },
      VALID_ANON_KEY as never,
    );
    expect(result.action).toBe("skipped-anon-source");
    // mcp.json must be untouched
    const after = fs.readFileSync(path.join(tmpDir, ".glasstrace", "mcp.json"), "utf-8");
    expect(after).toContain(VALID_ANON_KEY);
  });

  it("returns absent when there is no anon key on disk (dev-key-only project)", async () => {
    const result = await refreshGenericMcpConfigAtRuntime(
      tmpDir,
      { source: "env-local", key: VALID_DEV_KEY as never },
      null,
    );
    expect(result.action).toBe("absent");
  });

  it("returns absent when .glasstrace/mcp.json does not exist", async () => {
    writeAnonKey(tmpDir);
    const result = await refreshGenericMcpConfigAtRuntime(
      tmpDir,
      { source: "env-local", key: VALID_DEV_KEY as never },
      VALID_ANON_KEY as never,
    );
    expect(result.action).toBe("absent");
  });

  it("rewrites mcp.json with the effective dev key when SDK-shaped, atomically", async () => {
    writeAnonKey(tmpDir);
    writeManagedConfig(VALID_ANON_KEY);

    const result = await refreshGenericMcpConfigAtRuntime(
      tmpDir,
      { source: "env-local", key: VALID_DEV_KEY as never },
      VALID_ANON_KEY as never,
    );

    expect(result.action).toBe("rewrote");

    const configPath = path.join(tmpDir, ".glasstrace", "mcp.json");
    const after = fs.readFileSync(configPath, "utf-8");
    expect(after).toContain(`Bearer ${VALID_DEV_KEY}`);
    expect(after).not.toContain(VALID_ANON_KEY);

    // Permissions: file is 0o600
    const stat = fs.statSync(configPath);
    expect(stat.mode & 0o777).toBe(0o600);

    // Atomic write leaves no leftover .tmp sibling
    expect(fs.existsSync(configPath + ".tmp")).toBe(false);

    // Marker is updated to v2 with the effective source
    const marker = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".glasstrace", "mcp-connected"), "utf-8"),
    ) as { version: number; credentialSource: string; credentialHash: string };
    expect(marker.version).toBe(2);
    expect(marker.credentialSource).toBe("env-local");
    expect(marker.credentialHash).toBe(identityFingerprint(VALID_DEV_KEY));
  });

  it("preserves mcp.json when content is hand-edited (does not match SDK-shaped anon)", async () => {
    writeAnonKey(tmpDir);
    const dir = path.join(tmpDir, ".glasstrace");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const customContent = JSON.stringify(
      { mcpServers: { glasstrace: { url: "https://custom", headers: {} } } },
      null,
      2,
    );
    fs.writeFileSync(path.join(dir, "mcp.json"), customContent, { mode: 0o600 });

    const result = await refreshGenericMcpConfigAtRuntime(
      tmpDir,
      { source: "env-local", key: VALID_DEV_KEY as never },
      VALID_ANON_KEY as never,
    );

    expect(result.action).toBe("preserved");
    expect(fs.readFileSync(path.join(dir, "mcp.json"), "utf-8")).toBe(customContent);
    expect(fs.existsSync(path.join(dir, "mcp-connected"))).toBe(false);
  });

  it("emits the success nudge once per process and never includes raw key material", async () => {
    writeAnonKey(tmpDir);
    writeManagedConfig(VALID_ANON_KEY);

    await refreshGenericMcpConfigAtRuntime(
      tmpDir,
      { source: "env-local", key: VALID_DEV_KEY as never },
      VALID_ANON_KEY as never,
    );

    // Reset the project for a second invocation
    fs.rmSync(path.join(tmpDir, ".glasstrace", "mcp.json"), { force: true });
    writeManagedConfig(VALID_ANON_KEY);

    await refreshGenericMcpConfigAtRuntime(
      tmpDir,
      { source: "env-local", key: VALID_DEV_KEY as never },
      VALID_ANON_KEY as never,
    );

    const nudgeCount = stderrOutput.match(/MCP config refreshed/g)?.length ?? 0;
    expect(nudgeCount).toBe(1);

    // Critical: no raw key material in stderr
    expect(stderrOutput).not.toContain(VALID_DEV_KEY);
    expect(stderrOutput).not.toContain(VALID_ANON_KEY);
  });

  it("emits a Codex restart hint when persisted source is claimed-key", async () => {
    writeAnonKey(tmpDir);
    writeManagedConfig(VALID_ANON_KEY);

    await refreshGenericMcpConfigAtRuntime(
      tmpDir,
      { source: "claimed-key", key: VALID_DEV_KEY as never },
      VALID_ANON_KEY as never,
    );

    expect(stderrOutput).toContain("MCP config refreshed");
    expect(stderrOutput).toContain("Copy .glasstrace/claimed-key");
    expect(stderrOutput).not.toContain(VALID_DEV_KEY);
  });

  it("must not throw when the atomic write fails — returns 'preserved' and best-effort cleans up the tmp file", async () => {
    writeAnonKey(tmpDir);
    writeManagedConfig(VALID_ANON_KEY);

    // Force a writeFile failure by pre-creating mcp.json.tmp as a
    // directory; node:fs/promises.writeFile to a path that is a
    // directory throws EISDIR.
    const dir = path.join(tmpDir, ".glasstrace");
    fs.mkdirSync(path.join(dir, "mcp.json.tmp"), { recursive: true });

    const result = await refreshGenericMcpConfigAtRuntime(
      tmpDir,
      { source: "env-local", key: VALID_DEV_KEY as never },
      VALID_ANON_KEY as never,
    );

    expect(result.action).toBe("preserved");

    // The original mcp.json must be untouched
    const after = fs.readFileSync(path.join(dir, "mcp.json"), "utf-8");
    expect(after).toContain(VALID_ANON_KEY);
    expect(after).not.toContain(VALID_DEV_KEY);

    // Marker must not have been written
    expect(fs.existsSync(path.join(dir, "mcp-connected"))).toBe(false);
  });

  it("matches the agent-detection generic config shape (regression guard)", async () => {
    // If `generateMcpConfig({ name: "generic", ... })` ever diverges from
    // the inlined runtime helper, the staleness check stops detecting
    // SDK-managed configs. This test locks in the expected shape.
    writeAnonKey(tmpDir);
    writeManagedConfig(VALID_ANON_KEY);

    const result = await refreshGenericMcpConfigAtRuntime(
      tmpDir,
      { source: "env-local", key: VALID_DEV_KEY as never },
      VALID_ANON_KEY as never,
    );
    expect(result.action).toBe("rewrote");
  });
});
