import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnonApiKeySchema } from "@glasstrace/protocol";
import {
  getOrCreateAnonKey,
  readAnonKey,
} from "../../../packages/sdk/src/anon-key.js";

describe("getOrCreateAnonKey", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates and writes a key when no file exists", async () => {
    const key = await getOrCreateAnonKey(tempDir);
    expect(key).toMatch(/^gt_anon_[a-f0-9]{48}$/);

    // Verify file was written
    const fileContent = await readFile(join(tempDir, ".glasstrace", "anon_key"), "utf-8");
    expect(fileContent).toBe(key);
  });

  it("creates .glasstrace directory if it does not exist", async () => {
    await getOrCreateAnonKey(tempDir);
    const fileContent = await readFile(join(tempDir, ".glasstrace", "anon_key"), "utf-8");
    expect(fileContent).toMatch(/^gt_anon_[a-f0-9]{48}$/);
  });

  it("reads existing key from file on second run", async () => {
    const key1 = await getOrCreateAnonKey(tempDir);
    const key2 = await getOrCreateAnonKey(tempDir);
    expect(key1).toBe(key2);
  });

  it("validates existing key via AnonApiKeySchema", async () => {
    const key = await getOrCreateAnonKey(tempDir);
    const result = AnonApiKeySchema.safeParse(key);
    expect(result.success).toBe(true);
  });

  it("corrupt file triggers regeneration", async () => {
    // Write invalid content
    await mkdir(join(tempDir, ".glasstrace"), { recursive: true });
    await writeFile(join(tempDir, ".glasstrace", "anon_key"), "not_a_valid_key");

    const key = await getOrCreateAnonKey(tempDir);
    expect(key).toMatch(/^gt_anon_[a-f0-9]{48}$/);
    expect(key).not.toBe("not_a_valid_key");

    // Verify file was overwritten
    const fileContent = await readFile(join(tempDir, ".glasstrace", "anon_key"), "utf-8");
    expect(fileContent).toBe(key);
  });

  it("key file contains only the raw key string, no JSON, no newline", async () => {
    const key = await getOrCreateAnonKey(tempDir);
    const raw = await readFile(join(tempDir, ".glasstrace", "anon_key"), "utf-8");
    expect(raw).toBe(key);
    expect(raw).not.toContain("\n");
    expect(raw).not.toContain("{");
  });

  it("returns ephemeral key on write failure, logs warning", async () => {
    // Create .glasstrace as a read-only file (not a directory) to cause mkdir to fail
    await writeFile(join(tempDir, ".glasstrace"), "blocker");
    await chmod(join(tempDir, ".glasstrace"), 0o444);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const key = await getOrCreateAnonKey(tempDir);
      expect(key).toMatch(/^gt_anon_[a-f0-9]{48}$/);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      // Clean up: restore permissions so rm works
      await chmod(join(tempDir, ".glasstrace"), 0o755);
    }
  });

  it("ephemeral key is stable across repeated calls on write failure", async () => {
    // Create .glasstrace as a read-only file (not a directory) to cause mkdir to fail
    await writeFile(join(tempDir, ".glasstrace"), "blocker");
    await chmod(join(tempDir, ".glasstrace"), 0o444);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const key1 = await getOrCreateAnonKey(tempDir);
      const key2 = await getOrCreateAnonKey(tempDir);
      expect(key1).toBe(key2);
    } finally {
      warnSpy.mockRestore();
      await chmod(join(tempDir, ".glasstrace"), 0o755);
    }
  });

  it("regenerates when key has valid prefix but truncated hex", async () => {
    // A corrupted key with valid prefix but insufficient hex characters
    await mkdir(join(tempDir, ".glasstrace"), { recursive: true });
    await writeFile(join(tempDir, ".glasstrace", "anon_key"), "gt_anon_abc");

    const key = await getOrCreateAnonKey(tempDir);
    expect(key).toMatch(/^gt_anon_[a-f0-9]{48}$/);
    expect(key).not.toBe("gt_anon_abc");
  });

  it("concurrent calls return the same key", async () => {
    const [key1, key2] = await Promise.all([
      getOrCreateAnonKey(tempDir),
      getOrCreateAnonKey(tempDir),
    ]);
    expect(key1).toBe(key2);
  });

  it("reads existing valid key instead of generating a new one", async () => {
    // Pre-create a valid key file — getOrCreateAnonKey should return it
    // without attempting to write (exercises the early-return read path)
    const preExistingKey = "gt_anon_" + "b".repeat(48);
    await mkdir(join(tempDir, ".glasstrace"), { recursive: true });
    await writeFile(join(tempDir, ".glasstrace", "anon_key"), preExistingKey);

    const key = await getOrCreateAnonKey(tempDir);
    expect(key).toBe(preExistingKey);
  });

  it("defaults projectRoot to process.cwd()", async () => {
    const originalCwd = process.cwd();
    process.chdir(tempDir);

    try {
      const key = await getOrCreateAnonKey();
      expect(key).toMatch(/^gt_anon_[a-f0-9]{48}$/);

      const fileContent = await readFile(join(tempDir, ".glasstrace", "anon_key"), "utf-8");
      expect(fileContent).toBe(key);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe("getOrCreateAnonKey EEXIST retry loop", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("retries reading winner key when initial read returns null", async () => {
    const winnerKey = "gt_anon_" + "c".repeat(48);
    const keyDir = join(tempDir, ".glasstrace");
    const keyPath = join(keyDir, "anon_key");

    // Pre-create the directory so mkdir succeeds
    await mkdir(keyDir, { recursive: true, mode: 0o700 });

    // Create the key file with invalid content first (simulates
    // the winner's write not yet flushed / partially written)
    await writeFile(keyPath, "incomplete", { mode: 0o600 });

    // After a short delay, overwrite with the valid winner key.
    // This simulates the winner's write completing between retries.
    // The 10ms delay ensures the valid key appears after the initial
    // read but well before the first 50ms retry fires.
    const delayedWrite = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        writeFile(keyPath, winnerKey, { mode: 0o600 }).then(resolve, reject);
      }, 10);
    });

    const result = await getOrCreateAnonKey(tempDir);
    await delayedWrite;

    // Should have read the winner's key after retry, not generated a new one
    expect(result).toBe(winnerKey);
  });

  it("falls back to overwrite when all retries return null", async () => {
    const keyDir = join(tempDir, ".glasstrace");
    const keyPath = join(keyDir, "anon_key");

    // Pre-create the directory and file with permanently invalid content
    await mkdir(keyDir, { recursive: true, mode: 0o700 });
    await writeFile(keyPath, "permanently_corrupt", { mode: 0o600 });

    const result = await getOrCreateAnonKey(tempDir);

    // Should have generated a new key and overwritten the corrupt file
    expect(result).toMatch(/^gt_anon_[a-f0-9]{48}$/);
    expect(result).not.toBe("permanently_corrupt");

    // Verify the file was overwritten with the new key
    const fileContent = await readFile(keyPath, "utf-8");
    expect(fileContent).toBe(result);
  });
});

describe("readAnonKey", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns null when no file exists", async () => {
    const result = await readAnonKey(tempDir);
    expect(result).toBeNull();
  });

  it("returns the key when file exists and is valid", async () => {
    // Write a valid key
    await mkdir(join(tempDir, ".glasstrace"), { recursive: true });
    const validKey = "gt_anon_" + "a".repeat(48);
    await writeFile(join(tempDir, ".glasstrace", "anon_key"), validKey);

    const result = await readAnonKey(tempDir);
    expect(result).toBe(validKey);
  });

  it("returns ephemeral cached key when filesystem is unavailable", async () => {
    // Simulate write failure by blocking .glasstrace as a file
    await writeFile(join(tempDir, ".glasstrace"), "blocker");
    await chmod(join(tempDir, ".glasstrace"), 0o444);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // getOrCreateAnonKey caches an ephemeral key on write failure
    const ephemeralKey = await getOrCreateAnonKey(tempDir);

    // readAnonKey should now return the same ephemeral key
    const readResult = await readAnonKey(tempDir);
    expect(readResult).toBe(ephemeralKey);

    warnSpy.mockRestore();
    await chmod(join(tempDir, ".glasstrace"), 0o755);
  });

  it("returns null when file content is invalid", async () => {
    await mkdir(join(tempDir, ".glasstrace"), { recursive: true });
    await writeFile(join(tempDir, ".glasstrace", "anon_key"), "invalid_key");

    const result = await readAnonKey(tempDir);
    expect(result).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)(
    "error case: returns null on I/O error (read failure)",
    async () => {
      // Create the directory but make the file unreadable
      // Skipped when running as root since chmod 000 has no effect
      await mkdir(join(tempDir, ".glasstrace"), { recursive: true });
      await writeFile(join(tempDir, ".glasstrace", "anon_key"), "gt_anon_" + "a".repeat(48));
      await chmod(join(tempDir, ".glasstrace", "anon_key"), 0o000);

      const result = await readAnonKey(tempDir);
      expect(result).toBeNull();

      // Restore permissions for cleanup
      await chmod(join(tempDir, ".glasstrace", "anon_key"), 0o644);
    },
  );
});
