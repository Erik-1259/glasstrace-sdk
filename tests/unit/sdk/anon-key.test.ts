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

    const key = await getOrCreateAnonKey(tempDir);
    expect(key).toMatch(/^gt_anon_[a-f0-9]{48}$/);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    // Clean up: restore permissions so rm works
    await chmod(join(tempDir, ".glasstrace"), 0o755);
  });

  it("ephemeral key is stable across repeated calls on write failure", async () => {
    // Create .glasstrace as a read-only file (not a directory) to cause mkdir to fail
    await writeFile(join(tempDir, ".glasstrace"), "blocker");
    await chmod(join(tempDir, ".glasstrace"), 0o444);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const key1 = await getOrCreateAnonKey(tempDir);
    const key2 = await getOrCreateAnonKey(tempDir);
    expect(key1).toBe(key2);

    warnSpy.mockRestore();
    await chmod(join(tempDir, ".glasstrace"), 0o755);
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
