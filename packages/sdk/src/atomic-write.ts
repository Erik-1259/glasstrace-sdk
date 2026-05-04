/**
 * Atomic file-write helper.
 *
 * Implements the durability half of the atomic-write protocol
 * (`docs/component-designs/sdk-architecture.md` §4.3 — Atomic file
 * writes; durability protocol steps 6–9):
 *
 *   1. Write the payload to a sibling temp file in the **same**
 *      directory as the final target. The shared directory guarantees
 *      `rename(2)` stays on the same filesystem and therefore atomic
 *      per POSIX semantics.
 *   2. **fsync the temp file.** Forces data and metadata to durable
 *      storage before the rename is observable.
 *   3. **rename atomically into place.** Readers see either the old
 *      file contents or the new ones, never a partial write.
 *   4. **fsync the parent directory.** On POSIX, `rename(2)` durability
 *      is not guaranteed until the containing directory's own metadata
 *      is synced. Without this step, a power loss between rename and
 *      parent-dir sync can leave the rename invisible after reboot
 *      (the kernel acknowledges the syscall but the metadata never
 *      reached durable storage).
 *
 * Closes the durability gap that allowed DISC-494 (anon-key unlinked
 * silently on re-init under crash interleavings).
 *
 * Out-of-scope by design:
 *   - The `lstat → tmp → rename → re-lstat` TOCTOU re-check (spec
 *     §4.3 steps 1–2 and 7's re-verification) is next-major scope per
 *     `sdk-architecture.md` §4.3 — TOCTOU protection.
 *   - The `GLASSTRACE_TEST_CRASH_AFTER` crash-injection harness is
 *     next-major scope per `sdk-architecture.md` §4.3 — Crash-injection
 *     harness.
 *   - Structured error-with-step-number reporting is next-major scope
 *     per `sdk-architecture.md` §4.3 — durability protocol step 9.
 *
 * Cross-platform behavior:
 *   - On POSIX (Linux, macOS), the parent-directory fsync uses an
 *     `open(O_RDONLY) → fsync → close` sequence. This is the canonical
 *     way to flush directory metadata.
 *   - On Windows, opening a directory for read returns `EISDIR` (and
 *     `fsync` on the resulting handle would fail with `EINVAL` even
 *     if the open succeeded). NTFS's rename semantics also do not
 *     require an explicit directory fsync to commit the rename
 *     metadata. The helper therefore swallows `EISDIR`, `EINVAL`,
 *     `EPERM`, and `ENOTSUP` from the parent-dir fsync step. Any
 *     other error from the open/fsync/close sequence still propagates
 *     so genuine I/O failures are not silently ignored.
 *
 * Concurrency:
 *   - Two processes writing the same target concurrently follow
 *     last-rename-wins semantics. The helper does not lock; the
 *     caller is responsible for any external mutual-exclusion. This
 *     matches the existing 0.19.x behavior of every migrated call
 *     site — the helper does not change concurrency guarantees, only
 *     durability.
 *
 * Performance:
 *   - `fsync` is intrinsically expensive on rotational media (one
 *     full disk-cache flush). The sync variant is exposed for the
 *     `runtime-state.ts` writer, which runs in a signal handler with
 *     a strict time budget; existing callers were already issuing a
 *     blocking `writeFileSync + renameSync`, so the additional cost
 *     is the two `fsync` calls. On modern SSDs this remains in the
 *     low-millisecond range.
 *
 * Module-load safety: `node:fs` and `node:fs/promises` are loaded
 *   lazily so the module can be imported in non-Node environments
 *   (Edge Runtime, browser bundles) without crashing at import time.
 *   Calling any helper export in such an environment throws a clear
 *   error; callers that may run on the edge must therefore probe
 *   their own Node-availability before reaching this module (see
 *   `init-client.ts`'s `loadFsPathAsync`).
 *
 * @internal Not re-exported from `index.ts`/`node-entry.ts`/
 *   `edge-entry.ts`. Importable only from sibling SDK modules.
 */

import type { FileHandle } from "node:fs/promises";

/**
 * Resolves the parent directory of a path without importing `node:path`,
 * so this module remains importable in non-Node environments where
 * `node:path` is unavailable. Handles both POSIX (`/`) and Windows
 * (`\\`) separators because Windows paths can use either form.
 *
 * Behavior matches `path.dirname` for the inputs this module receives
 * (always absolute paths produced by SDK callers): finds the last
 * separator and returns the prefix; returns `"."` if no separator is
 * present (a relative leaf name); preserves the root for `/foo` →
 * `/`. Edge cases like trailing-separator inputs are not exercised by
 * SDK callers so are not modeled here.
 */
function parentDir(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  const lastBackslash = filePath.lastIndexOf("\\");
  const lastSep = Math.max(lastSlash, lastBackslash);
  if (lastSep < 0) return ".";
  if (lastSep === 0) return filePath.slice(0, 1); // root: "/x" → "/"
  return filePath.slice(0, lastSep);
}

/**
 * Options accepted by both `atomicWriteFile` and `atomicWriteFileSync`.
 *
 * The shape mirrors the relevant subset of `fs.writeFile`'s options
 * object. `mode` defaults to `0o600` (state files); callers writing
 * static or discoverable files (e.g., `.well-known/glasstrace.json`)
 * may pass `0o644`. `encoding` defaults to `"utf-8"` when the payload
 * is a string and is ignored when the payload is a `Uint8Array`.
 */
export interface AtomicWriteOptions {
  /**
   * POSIX file mode applied to the temp file before the rename.
   * Defaults to `0o600`. The mode applies to the temp file and is
   * carried through the rename; callers that need a different
   * post-rename mode should call `chmod` themselves after this
   * helper resolves.
   *
   * The helper re-applies this mode unconditionally via `chmod`/`chmodSync`
   * after writing, so a pre-existing temp file (e.g., residue from a
   * crashed prior run) cannot carry stale permissive bits into the
   * caller's renamed target. The fsync handle is opened read-only so
   * callers passing a read-only mode (e.g. `0o444`) are still supported.
   */
  mode?: number;
  /**
   * Encoding for string payloads. Defaults to `"utf-8"`. Ignored when
   * the payload is a `Uint8Array`.
   */
  encoding?: BufferEncoding;
}

/** Errno codes that the parent-dir fsync step is permitted to swallow. */
const PARENT_FSYNC_SWALLOWED_CODES: ReadonlySet<string> = new Set([
  "EISDIR",
  "EINVAL",
  "EPERM",
  "ENOTSUP",
]);

/**
 * Reads the `code` property off an `unknown` thrown value if present.
 * Helper avoids `as` casts on `err` and works with both plain objects
 * and `NodeJS.ErrnoException` instances.
 */
function errnoCodeOf(err: unknown): string | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Builds the path of the sibling temp file. The temp lives in the
 * same directory as the target so the eventual `rename(2)` stays on
 * the same filesystem.
 *
 * Callers may pre-compute their own temp paths (e.g., `<path>.tmp-
 * <pid>` for the discovery-file write to keep multi-process collisions
 * disambiguated). When they do, they call the helper's `*WithTmp`
 * variants. The default temp suffix is `.tmp` for parity with the
 * existing 0.19.x call sites.
 */
function defaultTmpPath(targetPath: string): string {
  return `${targetPath}.tmp`;
}

// ---------------------------------------------------------------------------
// Lazy module loaders
// ---------------------------------------------------------------------------

let fsPromisesCache: typeof import("node:fs/promises") | null | undefined;
let fsSyncCache: typeof import("node:fs") | null | undefined;

async function loadFsPromises(): Promise<typeof import("node:fs/promises")> {
  if (fsPromisesCache !== undefined) {
    if (fsPromisesCache === null) {
      throw new Error(
        "node:fs/promises is unavailable in this environment; atomicWriteFile cannot be used here.",
      );
    }
    return fsPromisesCache;
  }
  try {
    fsPromisesCache = await import("node:fs/promises");
    return fsPromisesCache;
  } catch {
    fsPromisesCache = null;
    throw new Error(
      "node:fs/promises is unavailable in this environment; atomicWriteFile cannot be used here.",
    );
  }
}

function loadFsSync(): typeof import("node:fs") {
  if (fsSyncCache !== undefined) {
    if (fsSyncCache === null) {
      throw new Error(
        "node:fs is unavailable in this environment; atomicWriteFileSync cannot be used here.",
      );
    }
    return fsSyncCache;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, glasstrace/no-unguarded-node-require -- guarded by the surrounding try/catch which caches `null` and surfaces a clean Error on subsequent calls; consumers gate with `isSyncFsAvailable()` (DISC-1555).
    fsSyncCache = require("node:fs") as typeof import("node:fs");
    return fsSyncCache;
  } catch {
    fsSyncCache = null;
    throw new Error(
      "node:fs is unavailable in this environment; atomicWriteFileSync cannot be used here.",
    );
  }
}

// ---------------------------------------------------------------------------
// Async variant
// ---------------------------------------------------------------------------

/**
 * Atomically writes `payload` to `targetPath` using
 * `tmp + fsync(tmp) + rename + fsync(parent)` semantics.
 *
 * On any error from the write/fsync/rename steps, the helper makes a
 * best-effort attempt to remove the temp file and rethrows the
 * original error. The parent-dir fsync step swallows
 * `EISDIR`/`EINVAL`/`EPERM`/`ENOTSUP` to support platforms where
 * directory fsync is not supported (notably Windows on NTFS).
 *
 * @param targetPath Absolute path to the final destination.
 * @param payload    `string` or `Uint8Array` payload.
 * @param options    See {@link AtomicWriteOptions}.
 */
export async function atomicWriteFile(
  targetPath: string,
  payload: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  return atomicWriteFileWithTmp(targetPath, defaultTmpPath(targetPath), payload, options);
}

/**
 * Async variant accepting an explicit `tmpPath`. The temp path MUST
 * live in the same directory as `targetPath` to preserve rename
 * atomicity. Used by `cli/discovery-file.ts` to disambiguate
 * concurrent writers via a `.tmp-<pid>` suffix.
 */
export async function atomicWriteFileWithTmp(
  targetPath: string,
  tmpPath: string,
  payload: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const encoding = options.encoding ?? "utf-8";
  const fsp = await loadFsPromises();

  let handle: FileHandle | null = null;
  try {
    // Step 1: write payload to the temp file.
    if (typeof payload === "string") {
      await fsp.writeFile(tmpPath, payload, { encoding, mode });
    } else {
      await fsp.writeFile(tmpPath, payload, { mode });
    }

    // Step 1a: re-apply the requested mode unconditionally. `writeFile`
    // only honors `mode` when it CREATES the file; if `tmpPath` is a
    // pre-existing residue from a prior crash (or a hostile actor) the
    // existing permissions are preserved, which would silently rename a
    // world-readable temp into place. Path-based `chmod` lets the fsync
    // handle below remain read-only, so callers that pass a read-only
    // mode (e.g. 0o444) are still supported.
    await fsp.chmod(tmpPath, mode);

    // Step 2: fsync the temp file. Open then fsync via the
    // `FileHandle.sync()` method — `writeFile` closes its internal
    // handle immediately, so we re-open here. Read-only is sufficient
    // for `fsync` and works for callers that supply a read-only `mode`.
    handle = await fsp.open(tmpPath, "r");
    await handle.sync();
    await handle.close();
    handle = null;

    // Step 3: rename into place. POSIX-atomic on same-filesystem.
    await fsp.rename(tmpPath, targetPath);
  } catch (err) {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // Best-effort: the original error takes precedence.
      }
    }
    await removeTmpResidueAsync(fsp, tmpPath);
    throw err;
  }

  // Step 4: fsync the parent directory. Failures on platforms that
  // do not support directory fsync are swallowed; genuine I/O errors
  // still propagate.
  await fsyncParentDirAsync(targetPath, fsp);
}

/**
 * Best-effort removal of the temp file after a failed atomic-write
 * step. Tries `unlink` first (the common case where the temp is a
 * regular file). If `unlink` fails with `EISDIR`/`EPERM` — meaning the
 * temp path resolves to a directory left behind by a prior crash or
 * misconfiguration — falls back to a non-recursive `rmdir`. Any error
 * from either operation is swallowed so the caller can rethrow the
 * original I/O failure.
 */
async function removeTmpResidueAsync(
  fsp: typeof import("node:fs/promises"),
  tmpPath: string,
): Promise<void> {
  try {
    await fsp.unlink(tmpPath);
    return;
  } catch (err) {
    const code = errnoCodeOf(err);
    if (code !== "EISDIR" && code !== "EPERM") {
      // Tmp may not exist (ENOENT), or unlink may have failed for an
      // unrelated reason. Either way, nothing more to do — the
      // original error takes precedence in the caller.
      return;
    }
  }
  try {
    await fsp.rmdir(tmpPath);
  } catch {
    // Directory may be non-empty or otherwise unremovable; the original
    // I/O failure remains the actionable error for the caller.
  }
}

async function fsyncParentDirAsync(
  targetPath: string,
  fsp: typeof import("node:fs/promises"),
): Promise<void> {
  const parent = parentDir(targetPath);
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(parent, "r");
    await handle.sync();
  } catch (err) {
    const code = errnoCodeOf(err);
    if (code !== undefined && PARENT_FSYNC_SWALLOWED_CODES.has(code)) {
      // Platform does not support directory fsync (Windows / NTFS).
      // The rename has already returned successfully; durability
      // semantics on those filesystems do not require an explicit
      // directory sync.
      return;
    }
    throw err;
  } finally {
    if (handle !== null) {
      try {
        await handle.close();
      } catch {
        // Close errors after a successful fsync are not actionable.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sync variant
// ---------------------------------------------------------------------------

/**
 * Synchronous counterpart to {@link atomicWriteFile}. Exists for
 * `runtime-state.ts`, which writes from a signal handler that
 * cannot await. Otherwise prefer the async variant.
 */
export function atomicWriteFileSync(
  targetPath: string,
  payload: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  atomicWriteFileSyncWithTmp(targetPath, defaultTmpPath(targetPath), payload, options);
}

/**
 * Sync variant accepting an explicit `tmpPath`. Mirrors
 * {@link atomicWriteFileWithTmp}.
 */
export function atomicWriteFileSyncWithTmp(
  targetPath: string,
  tmpPath: string,
  payload: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const mode = options.mode ?? 0o600;
  const encoding = options.encoding ?? "utf-8";
  const fs = loadFsSync();

  let fd: number | null = null;
  try {
    if (typeof payload === "string") {
      fs.writeFileSync(tmpPath, payload, { encoding, mode });
    } else {
      fs.writeFileSync(tmpPath, payload, { mode });
    }

    // Re-apply the requested mode unconditionally — see the matching
    // comment in `atomicWriteFileWithTmp` for the credential-leak
    // rationale when `tmpPath` is pre-existing residue.
    fs.chmodSync(tmpPath, mode);

    // Read-only is sufficient for `fsync` and works for callers that
    // supply a read-only `mode`.
    fd = fs.openSync(tmpPath, "r");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best-effort.
      }
    }
    removeTmpResidueSync(fs, tmpPath);
    throw err;
  }

  fsyncParentDirSyncWithFs(targetPath, fs);
}

/**
 * Synchronous counterpart to {@link removeTmpResidueAsync}. See the
 * async variant's JSDoc for the `EISDIR`/`EPERM` rationale.
 */
function removeTmpResidueSync(
  fs: typeof import("node:fs"),
  tmpPath: string,
): void {
  try {
    fs.unlinkSync(tmpPath);
    return;
  } catch (err) {
    const code = errnoCodeOf(err);
    if (code !== "EISDIR" && code !== "EPERM") {
      return;
    }
  }
  try {
    fs.rmdirSync(tmpPath);
  } catch {
    // Directory may be non-empty; original error takes precedence.
  }
}

/**
 * Synchronously fsyncs the parent directory of `targetPath`. Errors
 * matching {@link PARENT_FSYNC_SWALLOWED_CODES} (Windows / NTFS does
 * not support directory fsync) are silently ignored; other errors
 * propagate. Exposed for callers like `cli/discovery-file.ts` that
 * need to compose the steps manually around a backup-rollback flow.
 *
 * @internal Sibling-module use only.
 */
export function fsyncParentDirSync(targetPath: string): void {
  fsyncParentDirSyncWithFs(targetPath, loadFsSync());
}

function fsyncParentDirSyncWithFs(
  targetPath: string,
  fs: typeof import("node:fs"),
): void {
  const parent = parentDir(targetPath);
  let fd: number | null = null;
  try {
    fd = fs.openSync(parent, "r");
    fs.fsyncSync(fd);
  } catch (err) {
    const code = errnoCodeOf(err);
    if (code !== undefined && PARENT_FSYNC_SWALLOWED_CODES.has(code)) {
      return;
    }
    throw err;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Close errors after a successful fsync are not actionable.
      }
    }
  }
}

/**
 * Synchronously writes `payload` to `tmpPath` and fsyncs the
 * resulting file so its data and metadata are durable on disk
 * before any rename is observable. Throws on any I/O error from
 * either step; on throw, the partially-written tmp file is left
 * in place (callers handle cleanup so they can decide between
 * `unlink` and a backup-rollback strategy).
 *
 * Steps 1 and 2 of the SDK 2.0 §4.3 protocol. Pair with a `rename`
 * (step 3) and {@link fsyncParentDirSync} (step 4) — or use
 * {@link atomicWriteFileSync}/{@link atomicWriteFileSyncWithTmp}
 * which compose all four steps internally.
 *
 * @internal Sibling-module use only.
 */
export function writeAndFsyncTempSync(
  tmpPath: string,
  payload: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const mode = options.mode ?? 0o600;
  const encoding = options.encoding ?? "utf-8";
  const fs = loadFsSync();
  if (typeof payload === "string") {
    fs.writeFileSync(tmpPath, payload, { encoding, mode });
  } else {
    fs.writeFileSync(tmpPath, payload, { mode });
  }
  // Re-apply the requested mode in case `tmpPath` already existed —
  // `writeFileSync` only honors `mode` when creating the file, so a
  // stale residue could otherwise carry permissive bits into the
  // caller's eventual rename. Path-based `chmodSync` keeps the fsync
  // handle below read-only.
  fs.chmodSync(tmpPath, mode);
  // Read-only is sufficient for `fsync` and works for callers that
  // pass a read-only `mode`.
  const fd = fs.openSync(tmpPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Close errors after fsync are not actionable.
    }
  }
}

/**
 * Returns `true` when synchronous `node:fs` is reachable in the current
 * runtime, `false` otherwise. Callers that prefer a silent-skip path
 * over a thrown `node:fs is unavailable` error use this probe before
 * dispatching to {@link atomicWriteFileSync}.
 *
 * The probe shares the lazy-loader cache with the sync helpers, so a
 * `true` result also primes the cache for the subsequent write. This
 * keeps the probe overhead to one `require("node:fs")` per process.
 *
 * Background: tsup's bundled `__require` shim throws "Dynamic require
 * of \"node:fs\" is not supported" when the SDK is loaded as an ESM
 * module from a host like Next.js (DISC-1555). The runtime is a real
 * Node process — it just lacks a working synchronous `require()`
 * binding in the ESM scope. Async helpers are unaffected because
 * `await import("node:fs/promises")` is ESM-native.
 *
 * @internal Sibling-module use only.
 */
export function isSyncFsAvailable(): boolean {
  try {
    loadFsSync();
    return true;
  } catch {
    return false;
  }
}

/**
 * Test-only: clear the cached lazy-loaded modules. Allows test suites
 * that mock `node:fs`/`node:fs/promises` to ensure the helper re-runs
 * its module probe.
 *
 * @internal Tests only.
 */
export function _resetModuleCacheForTesting(): void {
  fsPromisesCache = undefined;
  fsSyncCache = undefined;
}
