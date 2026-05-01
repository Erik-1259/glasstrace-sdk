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
} from "../../../packages/sdk/src/mcp-runtime.js";
import { readClaimedKey } from "../../../packages/sdk/src/anon-key.js";

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
