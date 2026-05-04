/**
 * Tests for the atomic-write helper. Covers the durability invariant
 * `tmp + fsync(tmp) + rename + fsync(parent)` from SDK 2.0 §4.3
 * (`docs/component-designs/sdk-architecture.md:416–419`).
 *
 * Closes DISC-1515.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  mkdir,
} from "node:fs/promises";
import {
  mkdtempSync,
  readFileSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("atomicWriteFile (async)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-atomic-async-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes the payload atomically and leaves no temp residue", async () => {
    const { atomicWriteFile } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "state.json");
    await atomicWriteFile(target, '{"x":1}');
    expect(await readFile(target, "utf-8")).toBe('{"x":1}');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("applies the requested mode (0o600 default)", async () => {
    const { atomicWriteFile } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "state.json");
    await atomicWriteFile(target, "payload");
    const s = await stat(target);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("honors an explicit mode override (0o644)", async () => {
    const { atomicWriteFile } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "discovery.json");
    await atomicWriteFile(target, "payload", { mode: 0o644 });
    const s = await stat(target);
    expect(s.mode & 0o777).toBe(0o644);
  });

  it("accepts Uint8Array payloads", async () => {
    const { atomicWriteFile } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "binary.bin");
    const bytes = new Uint8Array([0x47, 0x54, 0x53, 0x44, 0x4b]); // "GTSDK"
    await atomicWriteFile(target, bytes);
    const buf = await readFile(target);
    expect(Array.from(buf)).toEqual(Array.from(bytes));
  });

  it("preserves the original file when writeFile to the temp path fails (regression: DISC-494 anon-key-unlink scenario)", async () => {
    const { atomicWriteFile } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "config");
    await writeFile(target, "ORIGINAL", { mode: 0o600 });

    // Pre-create the tmp path as a directory so writeFile fails with EISDIR.
    await mkdir(`${target}.tmp`);

    await expect(atomicWriteFile(target, "REPLACEMENT")).rejects.toThrow();

    // Original file content is preserved untouched.
    expect(await readFile(target, "utf-8")).toBe("ORIGINAL");
  });

  it("simulates a power-loss crash between writeFile and rename: original file unchanged", async () => {
    // Power-loss simulation: after writeFile + fsync(tmp) succeeds but
    // the rename never lands, the kernel/disk should reflect the
    // original target's contents on reboot (DISC-494). We model the
    // crash by using the lower-level `writeAndFsyncTempSync` primitive
    // and skipping the rename step entirely.
    const { writeAndFsyncTempSync } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "config");
    writeFileSync(target, "ORIGINAL", { mode: 0o600 });

    const tmpPath = `${target}.tmp`;
    writeAndFsyncTempSync(tmpPath, "REPLACEMENT", { mode: 0o600 });

    // Tmp file holds the new content (durably), but the target is
    // untouched because the rename never happened (simulating crash).
    expect(readFileSync(tmpPath, "utf-8")).toBe("REPLACEMENT");
    expect(readFileSync(target, "utf-8")).toBe("ORIGINAL");
  });
});

describe("atomicWriteFile order-of-operations (mocked node:fs/promises)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-atomic-order-"));
  });

  afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("invokes fs operations in the prescribed order: writeFile → fsync(tmp) → rename → fsync(parent)", async () => {
    const calls: string[] = [];
    const real = await import("node:fs/promises");
    const target = join(tempDir, "ordered.json");
    const tmpPath = `${target}.tmp`;

    vi.doMock("node:fs/promises", async () => {
      const writeFile: typeof real.writeFile = async (
        ...args: Parameters<typeof real.writeFile>
      ) => {
        calls.push(`writeFile:${args[0]}`);
        return real.writeFile(...args);
      };
      const open: typeof real.open = async (
        ...args: Parameters<typeof real.open>
      ) => {
        const handle = await real.open(...args);
        const where = String(args[0]);
        const tag = where === tempDir ? "open(parent)" : "open(tmp)";
        const origSync = handle.sync.bind(handle);
        const origClose = handle.close.bind(handle);
        handle.sync = async () => {
          calls.push(`fsync:${tag}`);
          return origSync();
        };
        handle.close = async () => {
          calls.push(`close:${tag}`);
          return origClose();
        };
        calls.push(tag);
        return handle;
      };
      const rename: typeof real.rename = async (
        ...args: Parameters<typeof real.rename>
      ) => {
        calls.push(`rename:${args[0]}->${args[1]}`);
        return real.rename(...args);
      };
      return {
        ...real,
        default: real,
        writeFile,
        open,
        rename,
      };
    });

    const { atomicWriteFile, _resetModuleCacheForTesting } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    _resetModuleCacheForTesting();

    await atomicWriteFile(target, "x");

    // Filter to the ordered events of interest.
    const sequence = calls.filter((c) =>
      /^(writeFile|open\(tmp\)|fsync:open\(tmp\)|close:open\(tmp\)|rename|open\(parent\)|fsync:open\(parent\)|close:open\(parent\))/.test(
        c,
      ),
    );

    const indexOf = (needle: string): number =>
      sequence.findIndex((c) => c.startsWith(needle));

    expect(indexOf("writeFile")).toBeGreaterThanOrEqual(0);
    expect(indexOf("open(tmp)")).toBeGreaterThan(indexOf("writeFile"));
    expect(indexOf("fsync:open(tmp)")).toBeGreaterThan(indexOf("open(tmp)"));
    expect(indexOf("close:open(tmp)")).toBeGreaterThan(
      indexOf("fsync:open(tmp)"),
    );
    expect(indexOf("rename")).toBeGreaterThan(indexOf("close:open(tmp)"));
    expect(indexOf("open(parent)")).toBeGreaterThan(indexOf("rename"));
    expect(indexOf("fsync:open(parent)")).toBeGreaterThan(
      indexOf("open(parent)"),
    );

    // Tmp residue removed via the successful rename.
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("cleans up the temp file when the rename fails", async () => {
    const real = await import("node:fs/promises");
    vi.doMock("node:fs/promises", async () => ({
      ...real,
      default: real,
      rename: async () => {
        throw new Error("simulated rename failure");
      },
    }));

    const { atomicWriteFile, _resetModuleCacheForTesting } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    _resetModuleCacheForTesting();

    const target = join(tempDir, "config");
    await expect(atomicWriteFile(target, "x")).rejects.toThrow(
      "simulated rename failure",
    );
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("swallows EISDIR/EINVAL/EPERM/ENOTSUP from the parent-dir fsync (Windows compatibility)", async () => {
    const codes = ["EISDIR", "EINVAL", "EPERM", "ENOTSUP"] as const;
    for (const code of codes) {
      const real = await import("node:fs/promises");
      const localTarget = join(tempDir, `dir-fsync-${code}`);

      vi.doMock("node:fs/promises", async () => ({
        ...real,
        default: real,
        open: async (
          ...args: Parameters<typeof real.open>
        ) => {
          if (args[0] === tempDir) {
            const err: NodeJS.ErrnoException = new Error(
              `simulated ${code} from directory open`,
            );
            err.code = code;
            throw err;
          }
          return real.open(...args);
        },
      }));

      const { atomicWriteFile, _resetModuleCacheForTesting } = await import(
        "../../../packages/sdk/src/atomic-write.js"
      );
      _resetModuleCacheForTesting();

      await expect(atomicWriteFile(localTarget, "ok")).resolves.toBeUndefined();
      expect(await readFile(localTarget, "utf-8")).toBe("ok");

      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("propagates non-swallowed errnos from the parent-dir fsync", async () => {
    const real = await import("node:fs/promises");

    vi.doMock("node:fs/promises", async () => ({
      ...real,
      default: real,
      open: async (
        ...args: Parameters<typeof real.open>
      ) => {
        if (args[0] === tempDir) {
          const err: NodeJS.ErrnoException = new Error("simulated EIO");
          err.code = "EIO";
          throw err;
        }
        return real.open(...args);
      },
    }));

    const { atomicWriteFile, _resetModuleCacheForTesting } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    _resetModuleCacheForTesting();

    const target = join(tempDir, "config");
    await expect(atomicWriteFile(target, "x")).rejects.toThrow("simulated EIO");
  });
});

describe("atomicWriteFileSync", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "glasstrace-atomic-sync-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock("node:fs");
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes the payload and leaves no tmp residue", async () => {
    const { atomicWriteFileSync } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "state.json");
    atomicWriteFileSync(target, '{"x":1}');
    expect(readFileSync(target, "utf-8")).toBe('{"x":1}');
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("applies the default mode (0o600)", async () => {
    const { atomicWriteFileSync } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "state.json");
    atomicWriteFileSync(target, "payload");
    const s = statSync(target);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("produces equivalent on-disk state to the async variant", async () => {
    const { atomicWriteFile, atomicWriteFileSync } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const syncTarget = join(tempDir, "sync.json");
    const asyncTarget = join(tempDir, "async.json");
    atomicWriteFileSync(syncTarget, '{"a":1}', { mode: 0o600 });
    await atomicWriteFile(asyncTarget, '{"a":1}', { mode: 0o600 });
    expect(readFileSync(syncTarget, "utf-8")).toBe(
      readFileSync(asyncTarget, "utf-8"),
    );
    expect(statSync(syncTarget).mode & 0o777).toBe(
      statSync(asyncTarget).mode & 0o777,
    );
  });

  it("preserves the original file when writeFile to the temp path fails", async () => {
    const { atomicWriteFileSync } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "config");
    writeFileSync(target, "ORIGINAL", { mode: 0o600 });
    mkdirSync(`${target}.tmp`); // pre-create tmp as a directory → EISDIR

    expect(() => atomicWriteFileSync(target, "REPLACEMENT")).toThrow();
    expect(readFileSync(target, "utf-8")).toBe("ORIGINAL");
  });

  it("cleans up the temp file when the rename fails", async () => {
    // Force renameSync to fail by making the target's parent be a
    // regular file rather than a directory. The temp file will be
    // written to the parent directory of `target` (which exists), but
    // renaming to `target` will hit ENOTDIR / EEXIST as appropriate.
    // Simpler: make the target itself a non-empty directory so rename
    // cannot replace it (most platforms refuse renaming a regular
    // file over a non-empty directory with ENOTEMPTY/EISDIR).
    const { atomicWriteFileSync } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "rename-blocked");
    mkdirSync(target);
    mkdirSync(join(target, "child")); // non-empty so rename cannot replace it

    expect(() => atomicWriteFileSync(target, "x")).toThrow();

    // Tmp was cleaned up despite the rename failure.
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });
});

describe("atomicWriteFileWithTmp / atomicWriteFileSyncWithTmp", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-atomic-tmp-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uses the explicit tmp path supplied by the caller (async)", async () => {
    const { atomicWriteFileWithTmp } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "discovery.json");
    const tmp = join(tempDir, "discovery.json.tmp-1234");
    await atomicWriteFileWithTmp(target, tmp, '{"k":"v"}', { mode: 0o644 });
    expect(await readFile(target, "utf-8")).toBe('{"k":"v"}');
    expect(existsSync(tmp)).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  it("uses the explicit tmp path supplied by the caller (sync)", async () => {
    const { atomicWriteFileSyncWithTmp } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "discovery.json");
    const tmp = join(tempDir, "discovery.json.tmp-5678");
    atomicWriteFileSyncWithTmp(target, tmp, '{"k":"v"}', { mode: 0o644 });
    expect(readFileSync(target, "utf-8")).toBe('{"k":"v"}');
    expect(existsSync(tmp)).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });
});

describe("writeAndFsyncTempSync + fsyncParentDirSync", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "glasstrace-atomic-compose-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock("node:fs");
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writeAndFsyncTempSync persists the payload to the temp path", async () => {
    const { writeAndFsyncTempSync } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const tmpPath = join(tempDir, "manual.tmp");
    writeAndFsyncTempSync(tmpPath, "payload", { mode: 0o600 });
    expect(readFileSync(tmpPath, "utf-8")).toBe("payload");
    expect(statSync(tmpPath).mode & 0o777).toBe(0o600);
  });

  it("fsyncParentDirSync is a no-op when EISDIR is thrown by openSync (mocked)", async () => {
    const real = await import("node:fs");
    vi.doMock("node:fs", async () => ({
      ...real,
      default: real,
      openSync: (
        p: Parameters<typeof real.openSync>[0],
        flags: Parameters<typeof real.openSync>[1],
        mode?: Parameters<typeof real.openSync>[2],
      ) => {
        if (p === tempDir) {
          const err: NodeJS.ErrnoException = new Error("EISDIR");
          err.code = "EISDIR";
          throw err;
        }
        return real.openSync(p, flags, mode);
      },
    }));

    const { fsyncParentDirSync, _resetModuleCacheForTesting } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    _resetModuleCacheForTesting();

    const target = join(tempDir, "any.json");
    expect(() => fsyncParentDirSync(target)).not.toThrow();
  });
});

describe("stale-tmp permission regression (security)", () => {
  // Regression coverage for the credential-leak risk where a pre-
  // existing temp file (from a prior crash, manual `touch`, or
  // hostile actor) keeps its old permissions because `writeFile`
  // only honors `mode` on file CREATION. The helper must re-apply
  // the requested mode unconditionally before the rename so a
  // permissive stale temp cannot be promoted into the final target.
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-atomic-stalemode-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("async: stale tmpPath at 0o644 → renamed target ends up at 0o600", async () => {
    const { atomicWriteFile } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "config");
    const tmpPath = `${target}.tmp`;
    // Pre-create the tmp at a permissive mode (simulating residue
    // from a crash or manual creation). `writeFile` will overwrite
    // contents but Node preserves the existing mode bits.
    await writeFile(tmpPath, "stale", { mode: 0o644 });
    expect((await stat(tmpPath)).mode & 0o777).toBe(0o644);

    await atomicWriteFile(target, "fresh", { mode: 0o600 });

    expect(await readFile(target, "utf-8")).toBe("fresh");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("sync: stale tmpPath at 0o644 → renamed target ends up at 0o600", async () => {
    const { atomicWriteFileSync } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "config");
    const tmpPath = `${target}.tmp`;
    writeFileSync(tmpPath, "stale", { mode: 0o644 });
    expect(statSync(tmpPath).mode & 0o777).toBe(0o644);

    atomicWriteFileSync(target, "fresh", { mode: 0o600 });

    expect(readFileSync(target, "utf-8")).toBe("fresh");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("async: default mode (no option) is 0o600 even with stale 0o644 tmp", async () => {
    const { atomicWriteFile } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "default-mode");
    const tmpPath = `${target}.tmp`;
    await writeFile(tmpPath, "stale", { mode: 0o644 });

    await atomicWriteFile(target, "fresh");

    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("sync: default mode (no option) is 0o600 even with stale 0o644 tmp", async () => {
    const { atomicWriteFileSync } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const target = join(tempDir, "default-mode");
    const tmpPath = `${target}.tmp`;
    writeFileSync(tmpPath, "stale", { mode: 0o644 });

    atomicWriteFileSync(target, "fresh");

    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("writeAndFsyncTempSync: stale tmpPath at 0o644 → tmpPath ends up at the requested 0o600", async () => {
    const { writeAndFsyncTempSync } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    const tmpPath = join(tempDir, "compose.tmp");
    writeFileSync(tmpPath, "stale", { mode: 0o644 });
    expect(statSync(tmpPath).mode & 0o777).toBe(0o644);

    writeAndFsyncTempSync(tmpPath, "fresh", { mode: 0o600 });

    expect(readFileSync(tmpPath, "utf-8")).toBe("fresh");
    expect(statSync(tmpPath).mode & 0o777).toBe(0o600);
  });
});

describe("stale-directory tmp cleanup recovery", () => {
  // Regression coverage for cleanup paths that previously called
  // only `unlink(tmpPath)` and would silently leave behind a
  // directory if `tmpPath` resolved to one. After the fix the helper
  // falls back to a non-recursive `rmdir` on `EISDIR`/`EPERM`, so a
  // stale empty directory does not permanently block future writes.
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-atomic-staledir-"));
  });

  afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("node:fs");
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("async: stale empty directory at tmpPath is removed during cleanup so the next write succeeds", async () => {
    const real = await import("node:fs/promises");
    // Force the rename step to fail so the catch block runs.
    vi.doMock("node:fs/promises", async () => ({
      ...real,
      default: real,
      rename: async () => {
        throw new Error("simulated rename failure");
      },
    }));

    const { atomicWriteFile, _resetModuleCacheForTesting } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    _resetModuleCacheForTesting();

    const target = join(tempDir, "config");
    const tmpPath = `${target}.tmp`;
    // Seed an empty directory at the temp path. After writeFile
    // fails with EISDIR (or after a forced rename failure), the
    // cleanup path should rmdir the empty directory.
    await mkdir(tmpPath);

    await expect(atomicWriteFile(target, "x")).rejects.toThrow();

    // Stale directory removed by the cleanup path.
    expect(existsSync(tmpPath)).toBe(false);

    // Restore real fs and confirm a follow-up write now succeeds —
    // i.e. the stale directory no longer blocks future writes.
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
    const { atomicWriteFile: realAtomicWriteFile, _resetModuleCacheForTesting: reset2 } =
      await import("../../../packages/sdk/src/atomic-write.js");
    reset2();
    await realAtomicWriteFile(target, "ok");
    expect(await readFile(target, "utf-8")).toBe("ok");
  });

  it("sync: stale empty directory at tmpPath is removed during cleanup so the next write succeeds", async () => {
    const real = await import("node:fs");
    vi.doMock("node:fs", async () => ({
      ...real,
      default: real,
      renameSync: () => {
        throw new Error("simulated rename failure");
      },
    }));

    const { atomicWriteFileSync, _resetModuleCacheForTesting } = await import(
      "../../../packages/sdk/src/atomic-write.js"
    );
    _resetModuleCacheForTesting();

    const target = join(tempDir, "config");
    const tmpPath = `${target}.tmp`;
    mkdirSync(tmpPath);

    expect(() => atomicWriteFileSync(target, "x")).toThrow();

    expect(existsSync(tmpPath)).toBe(false);

    vi.doUnmock("node:fs");
    vi.resetModules();
    const { atomicWriteFileSync: realSync, _resetModuleCacheForTesting: reset2 } =
      await import("../../../packages/sdk/src/atomic-write.js");
    reset2();
    realSync(target, "ok");
    expect(readFileSync(target, "utf-8")).toBe("ok");
  });
});

describe("smoke: existing atomic-write call sites still produce expected files after migration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "glasstrace-atomic-smoke-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("init-client.saveCachedConfig produces a readable .glasstrace/config", async () => {
    const { saveCachedConfig } = await import(
      "../../../packages/sdk/src/init-client.js"
    );
    await saveCachedConfig(
      {
        config: {
          requestBodies: false,
          queryParamValues: false,
          envVarValues: false,
          fullConsoleOutput: false,
          importGraph: false,
          consoleErrors: false,
        },
        subscriptionStatus: "anonymous",
        minimumSdkVersion: "0.0.0",
        apiVersion: "v1",
        tierLimits: {
          tracesPerMinute: 100,
          storageTtlHours: 48,
          maxTraceSizeBytes: 512000,
          maxConcurrentSessions: 1,
        },
      } as import("@glasstrace/protocol").SdkInitResponse,
      tempDir,
    );
    const written = await readFile(join(tempDir, ".glasstrace", "config"), "utf-8");
    const parsed = JSON.parse(written) as { response: unknown; cachedAt: number };
    expect(parsed.response).toBeDefined();
    expect(typeof parsed.cachedAt).toBe("number");
    // No leftover .tmp sibling
    expect(existsSync(join(tempDir, ".glasstrace", "config.tmp"))).toBe(false);
  });

  it("uninit.writeShutdownMarker produces .glasstrace/shutdown-requested", async () => {
    const { writeShutdownMarker } = await import(
      "../../../packages/sdk/src/cli/uninit.js"
    );
    mkdirSync(join(tempDir, ".glasstrace"));
    const ok = writeShutdownMarker(tempDir);
    expect(ok).toBe(true);
    const body = readFileSync(
      join(tempDir, ".glasstrace", "shutdown-requested"),
      "utf-8",
    );
    expect(JSON.parse(body)).toMatchObject({ requestedAt: expect.any(String) });
    expect(
      existsSync(join(tempDir, ".glasstrace", "shutdown-requested.tmp")),
    ).toBe(false);
  });
});
