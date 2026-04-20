import * as fs from "node:fs";
import * as path from "node:path";
import { AnonApiKeySchema } from "@glasstrace/protocol";
import type { AnonApiKey } from "@glasstrace/protocol";

/**
 * Standardized static discovery-file path, served at
 * `<static-root>/.well-known/glasstrace.json` (per RFC 8615) with
 * MIME type `application/json`.
 *
 * The SDK writes the file to this relative path under the
 * framework-specific static root (`public/` for Next.js, Remix, Astro;
 * `static/` for SvelteKit) and the browser extension fetches it from
 * the same path under the deployed origin.
 *
 * @drift-check RFC 8615 (https://www.rfc-editor.org/rfc/rfc8615) + ../glasstrace-product/docs/component-designs/sdk-2.0.md §7.1 Static discovery file
 */
export const WELL_KNOWN_GLASSTRACE_PATH = ".well-known/glasstrace.json" as const;

/**
 * Current schema version for `.well-known/glasstrace.json`. Consumers
 * (primarily the Glasstrace browser extension) MUST tolerate unknown
 * integers >= 1 per the forward-compatibility rule in the design doc
 * ("SDK Discovery Endpoint / Static File — Component Design", §5.3).
 */
export const DISCOVERY_FILE_VERSION = 1 as const;

/**
 * Schema of the static discovery file written by `sdk init`.
 *
 * Version 1 defines exactly two required fields: `version` and `key`.
 * Additional fields may appear in later schema versions — consumers MUST
 * ignore unknown fields (forward-compatibility) and MUST reject files
 * whose `key` does not match `^gt_anon_[a-f0-9]{48}$`.
 */
export interface DiscoveryFileV1 {
  version: typeof DISCOVERY_FILE_VERSION;
  key: AnonApiKey;
}

/**
 * Detected framework-specific static root. `public` covers Next.js,
 * Remix, and Astro; `static` covers SvelteKit. No other frameworks
 * differ today per the design doc's §4.3 table.
 */
export type StaticRootLayout = "public" | "static";

/**
 * Result returned by {@link resolveStaticRoot} so callers can report the
 * framework-specific path they targeted (used in init summary lines and
 * rollback output).
 */
export interface StaticRootResolution {
  /** Absolute path to the static root directory (may not exist yet). */
  absolutePath: string;
  /** Which layout was chosen. */
  layout: StaticRootLayout;
}

/**
 * Describes the outcome of a single call to {@link writeDiscoveryFile} so
 * callers can surface an accurate summary line without re-reading the
 * file. Mirrors the DISC-1247 Scenario 2 re-init preservation contract:
 * a valid file whose `key` already matches the on-disk anon key is left
 * alone rather than rewritten.
 */
export type WriteDiscoveryAction =
  | "created"
  | "updated-stale"
  | "skipped-matches"
  | "skipped-foreign"
  | "failed";

/**
 * Structured result from {@link writeDiscoveryFile}.
 */
export interface WriteDiscoveryResult {
  action: WriteDiscoveryAction;
  /** Absolute path of the discovery file (whether or not it was written). */
  filePath: string;
  /** Static root that was resolved, useful for `.gitignore` wiring. */
  layout: StaticRootLayout;
  /**
   * When `action === "failed"`, a short human-readable reason. Never
   * contains anon key bytes — callers can forward it to logs safely.
   */
  error?: string;
}

/**
 * Detects the project's framework-specific static root using the ordered
 * check from §4.4 of the design doc:
 *
 * 1. Classify as SvelteKit (→ `static/`) when `package.json` declares
 *    `"type": "module"` AND the project contains `svelte.config.js` (or
 *    `svelte.config.ts`) OR `src/app.html`. These signals together are
 *    specific enough to avoid false positives on generic ESM projects.
 * 2. Otherwise use `public/` — this covers Next.js, Remix, Astro, and
 *    plain Node web apps, which all serve `public/` verbatim.
 *
 * Returns the absolute directory path and the chosen layout. Does NOT
 * create the directory; callers use {@link writeDiscoveryFile}, which
 * creates any missing parents atomically.
 *
 * @internal Exported for unit testing only.
 */
export function resolveStaticRoot(projectRoot: string): StaticRootResolution {
  if (isSvelteKitProject(projectRoot)) {
    return {
      absolutePath: path.join(projectRoot, "static"),
      layout: "static",
    };
  }
  return {
    absolutePath: path.join(projectRoot, "public"),
    layout: "public",
  };
}

/**
 * Heuristic for SvelteKit detection. The design doc deliberately scopes
 * the check narrowly so a plain ESM library is never misclassified —
 * `svelte.config.{js,ts}` or `src/app.html` is the SvelteKit fingerprint,
 * and both must coexist with an ESM package.json.
 */
function isSvelteKitProject(projectRoot: string): boolean {
  const pkgPath = path.join(projectRoot, "package.json");
  let isEsm = false;
  try {
    const pkgContent = fs.readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(pkgContent) as { type?: unknown };
    isEsm = parsed.type === "module";
  } catch {
    // Missing or malformed package.json — fall through to default layout.
    return false;
  }
  if (!isEsm) return false;

  const svelteConfigJs = path.join(projectRoot, "svelte.config.js");
  const svelteConfigTs = path.join(projectRoot, "svelte.config.ts");
  const appHtml = path.join(projectRoot, "src", "app.html");
  return (
    fs.existsSync(svelteConfigJs) ||
    fs.existsSync(svelteConfigTs) ||
    fs.existsSync(appHtml)
  );
}

/**
 * Returns the project-relative path of the discovery file for the given
 * layout, suitable for surfacing in summary lines and `.gitignore` entries.
 */
export function relativeDiscoveryPath(layout: StaticRootLayout): string {
  const rootDir = layout === "static" ? "static" : "public";
  return `${rootDir}/${WELL_KNOWN_GLASSTRACE_PATH}`;
}

/**
 * Parses an existing discovery file and returns its key if the schema is
 * valid, or `null` when the file is missing, unreadable, not JSON, or
 * does not match the version-1 shape. The check is deliberately strict —
 * a corrupt or third-party-authored file is treated as "no file" so
 * {@link writeDiscoveryFile} overwrites it with a fresh SDK-managed copy.
 *
 * Extra unknown fields are tolerated (§5.3 forward-compatibility).
 *
 * @internal Exported for unit testing only.
 */
export function readExistingDiscoveryFile(
  filePath: string,
): { key: AnonApiKey; extras: Record<string, unknown> } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const versionRaw = obj.version;
  if (
    typeof versionRaw !== "number" ||
    !Number.isInteger(versionRaw) ||
    versionRaw < 1
  ) {
    return null;
  }

  const keyResult = AnonApiKeySchema.safeParse(obj.key);
  if (!keyResult.success) {
    return null;
  }

  // Preserve user-added fields (extras) so re-init round-trips any custom
  // keys the consumer added. `version` and `key` are SDK-managed and
  // excluded from the extras object.
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "version" || k === "key") continue;
    extras[k] = v;
  }

  return { key: keyResult.data, extras };
}

/**
 * Serializes the discovery payload deterministically (pretty-printed JSON
 * with a trailing newline). Deterministic output keeps git diffs clean
 * when the file is checked in and matches the atomic-write contract:
 * byte-identical output on re-init when `extras` is unchanged.
 */
function serializeDiscoveryPayload(
  key: AnonApiKey,
  extras: Record<string, unknown>,
): string {
  // Key ordering: version, key, then extras in their original insertion
  // order. Preserves DISC-1247 Scenario 2 alignment — a user who added
  // `"note": "…"` after `"key"` sees the same ordering on re-init.
  const payload: Record<string, unknown> = {
    version: DISCOVERY_FILE_VERSION,
    key,
    ...extras,
  };
  return JSON.stringify(payload, null, 2) + "\n";
}

/**
 * Writes the discovery file at `<staticRoot>/.well-known/glasstrace.json`
 * atomically.
 *
 * Behavior (per design doc §6.1 and §6.5):
 *
 * - When the target file does not exist, creates it with `{ version: 1,
 *   key: <anonKey> }` after creating the `.well-known/` directory if
 *   missing.
 * - When the target exists AND parses as a valid version-1 payload AND
 *   its `key` matches the supplied `anonKey`: preserves the file (and
 *   any user-added extra fields) and returns `"skipped-matches"`.
 * - When the target exists AND parses valid BUT its `key` does not
 *   match: rewrites the file with the fresh key, preserving extras.
 *   Returns `"updated-stale"`.
 * - When the target exists BUT fails to parse (corrupt, foreign-authored,
 *   wrong schema): rewrites with a fresh SDK-managed payload and returns
 *   `"skipped-foreign"` to signal that user content was not preserved.
 * - On any unexpected I/O error: returns `"failed"` with an error string.
 *
 * Uses a sibling temp file + `renameSync` for atomicity so concurrent
 * readers (e.g., a browser extension polling during dev server startup)
 * never observe a half-written file.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param anonKey - The anon key currently on disk (see `anon-key.ts`).
 */
export function writeDiscoveryFile(
  projectRoot: string,
  anonKey: AnonApiKey,
): WriteDiscoveryResult {
  const { absolutePath: staticRoot, layout } = resolveStaticRoot(projectRoot);
  const wellKnownDir = path.join(staticRoot, ".well-known");
  const filePath = path.join(wellKnownDir, "glasstrace.json");

  let existingAction: WriteDiscoveryAction;
  let extras: Record<string, unknown> = {};

  if (fs.existsSync(filePath)) {
    const existing = readExistingDiscoveryFile(filePath);
    if (existing === null) {
      // Unreadable / malformed / non-SDK content — overwrite with a
      // fresh payload so the extension can discover the current key.
      // Extras are NOT preserved because we cannot safely parse them.
      existingAction = "skipped-foreign";
    } else if (existing.key === anonKey) {
      // Valid and already matches — leave the file alone (§6.5 step 2).
      return {
        action: "skipped-matches",
        filePath,
        layout,
      };
    } else {
      // Valid but stale — replace the key, preserve extras (§6.5 step 3).
      extras = existing.extras;
      existingAction = "updated-stale";
    }
  } else {
    existingAction = "created";
  }

  const tmpPath = `${filePath}.tmp-${process.pid}`;
  // On Windows, `renameSync` fails with EPERM/EEXIST when the
  // destination already exists. Rather than `unlink` the destination
  // first (which would cause data loss if the subsequent rename fails),
  // move the destination to a sibling backup path, commit the rename,
  // and only then delete the backup. If the rename fails, restore the
  // backup so the original file is preserved.
  const needsWindowsReplace =
    process.platform === "win32" && fs.existsSync(filePath);
  const backupPath = needsWindowsReplace
    ? `${filePath}.bak-${process.pid}`
    : null;

  try {
    fs.mkdirSync(wellKnownDir, { recursive: true });
    const payload = serializeDiscoveryPayload(anonKey, extras);
    fs.writeFileSync(tmpPath, payload, { encoding: "utf-8" });

    if (backupPath !== null) {
      fs.renameSync(filePath, backupPath);
      try {
        fs.renameSync(tmpPath, filePath);
      } catch (renameErr) {
        try {
          fs.renameSync(backupPath, filePath);
        } catch {
          // Restoration failed; nothing more we can do. Surface the
          // original rename error below so the caller sees the cause.
        }
        throw renameErr;
      }
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // Backup cleanup is best-effort; a stale `.bak-<pid>` is
        // preferable to a spurious failure after a successful write.
      }
    } else {
      fs.renameSync(tmpPath, filePath);
    }

    return { action: existingAction, filePath, layout };
  } catch (err) {
    // Best-effort: remove the temp file if it was created before the
    // failure so a stale `.tmp-<pid>` does not clutter `.well-known/`.
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Swallow: the write has already failed; do not mask the root cause.
    }
    return {
      action: "failed",
      filePath,
      layout,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Describes the outcome of {@link removeDiscoveryFile}. `"removed"` means
 * the file existed and was deleted; `"not-found"` means there was nothing
 * to remove (no error). `"failed"` preserves an error string.
 */
export type RemoveDiscoveryAction = "removed" | "not-found" | "failed";

/** Structured result from {@link removeDiscoveryFile}. */
export interface RemoveDiscoveryResult {
  action: RemoveDiscoveryAction;
  filePath: string;
  layout: StaticRootLayout;
  /** True when the enclosing `.well-known/` directory was removed too. */
  directoryRemoved: boolean;
  error?: string;
}

/**
 * Removes the discovery file written by {@link writeDiscoveryFile} if
 * present, and removes the enclosing `.well-known/` directory when it
 * becomes empty. Tolerant of missing files, missing directories, and
 * user-owned sibling content inside `.well-known/` (never deletes a
 * sibling file).
 *
 * Checks BOTH `public/.well-known/glasstrace.json` and
 * `static/.well-known/glasstrace.json` rather than only the
 * currently-inferred layout: if layout detection changes between
 * init and uninit (for example, a SvelteKit project has its
 * `package.json` modified so the heuristic no longer matches),
 * the file written under the original layout would otherwise
 * be orphaned.
 *
 * Matches the uninit contract from design doc §6.4.
 *
 * @param projectRoot - Absolute path to the project root directory.
 */
export function removeDiscoveryFile(
  projectRoot: string,
): RemoveDiscoveryResult {
  const { layout: inferredLayout } = resolveStaticRoot(projectRoot);

  // Sweep both candidate layouts so an orphaned file in the non-inferred
  // location is still cleaned up. The returned layout describes where
  // a file was actually removed (preferring the inferred layout when a
  // file existed in both, which is not a supported state but is
  // tolerated); when neither layout had a file, the returned layout
  // mirrors the inferred one so callers surface a stable relative path.
  const layouts: StaticRootLayout[] = ["public", "static"];

  interface LayoutOutcome {
    layout: StaticRootLayout;
    filePath: string;
    removed: boolean;
    directoryRemoved: boolean;
  }
  const outcomes: LayoutOutcome[] = [];

  for (const layout of layouts) {
    const staticRoot = path.join(projectRoot, layout);
    const wellKnownDir = path.join(staticRoot, ".well-known");
    const filePath = path.join(wellKnownDir, "glasstrace.json");

    let removed = false;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        removed = true;
      }
    } catch (err) {
      return {
        action: "failed",
        filePath,
        layout,
        directoryRemoved: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Only attempt to prune the enclosing `.well-known/` when we actually
    // removed the discovery file from this layout. Pruning unconditionally
    // would delete a user-owned empty directory (that Glasstrace never
    // populated) as a silent side effect of `sdk uninit`.
    let directoryRemoved = false;
    if (removed) {
      try {
        if (fs.existsSync(wellKnownDir)) {
          const entries = fs.readdirSync(wellKnownDir);
          if (entries.length === 0) {
            fs.rmdirSync(wellKnownDir);
            directoryRemoved = true;
          }
        }
      } catch {
        // Best-effort cleanup; never surface as an error to uninit.
      }
    }

    outcomes.push({ layout, filePath, removed, directoryRemoved });
  }

  // Pick the outcome to report: prefer one where a file was removed. When
  // both layouts had a file (not a supported state, but tolerated),
  // prefer the inferred layout. When neither had a file, report the
  // inferred layout so callers receive a stable relative path.
  const removals = outcomes.filter((o) => o.removed);
  const chosen: LayoutOutcome = (() => {
    if (removals.length === 0) {
      return (
        outcomes.find((o) => o.layout === inferredLayout) ?? outcomes[0]!
      );
    }
    if (removals.length === 1) return removals[0]!;
    return (
      removals.find((o) => o.layout === inferredLayout) ?? removals[0]!
    );
  })();

  // Propagate directoryRemoved across both sweeps so the uninit summary
  // reflects every pruned directory even when only one was the primary.
  const anyDirectoryRemoved = outcomes.some((o) => o.directoryRemoved);

  return {
    action: removals.length > 0 ? "removed" : "not-found",
    filePath: chosen.filePath,
    layout: chosen.layout,
    directoryRemoved: chosen.directoryRemoved || anyDirectoryRemoved,
  };
}
