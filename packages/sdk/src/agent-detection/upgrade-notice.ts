import * as fs from "node:fs";
import * as path from "node:path";
import { isEndMarkerLine, parseStartMarkerLine } from "./inject.js";

/**
 * SDK-050 / DISC-1592 stale-managed-section warning.
 *
 * Detects a project whose agent instruction file (CLAUDE.md /
 * .cursorrules / codex.md) was rendered by an older `@glasstrace/sdk`
 * and emits a single stderr warning at SDK init pointing the user at
 * the upgrade command.
 *
 * Constraints (from SDK-050 Required Semantics §2 Item 3):
 *   - Stderr only; never stdout. Must not affect tracing behaviour.
 *   - At most once per process boot, even when `registerGlasstrace()`
 *     is invoked more than once in the same process (test runners,
 *     hot-reload, multiple register calls).
 *   - Node.js runtime only — no-op when `process` / `fs` / stderr are
 *     unavailable. Never throws and never writes to `console`.
 *   - Must not mutate any file at runtime. The warning is decided
 *     locally from the on-disk stamp and the SDK's own version
 *     constant (no network I/O).
 *   - Respects `GLASSTRACE_DISABLE_UPGRADE_NOTICE` (truthy values
 *     `"1"`, `"true"`, `"yes"`, case-insensitive).
 *   - Warning text contains no user-controlled content. File names
 *     come from a hardcoded set; the on-disk stamp is parsed for
 *     comparison only and is never echoed back into the warning
 *     (defends against terminal-escape-sequence injection via a
 *     hand-edited stamp).
 *
 * Only stamped sections (SDK-050+) participate. Legacy unstamped
 * sections (pre-SDK-050) trigger no warning by spec — those users
 * receive the upgraded text on their next `npx glasstrace mcp add`
 * or `npx glasstrace upgrade-instructions` run.
 */

/**
 * Module-level guard that enforces "at most one warning per process
 * boot." Reset only via {@link _resetUpgradeNoticeForTesting} so that
 * unit tests can exercise the warning path repeatedly.
 */
let warningEmitted = false;

/**
 * Hardcoded set of agent instruction filenames to inspect, relative
 * to the supplied project root. Matches the file targets the SDK's
 * own scaffolding writes to (claude/codex/cursor) — see
 * `packages/sdk/src/agent-detection/configs.ts`. Restricting the
 * scan to this set keeps the warning fast and ensures the warning
 * text never interpolates a user-supplied or attacker-supplied
 * filename.
 */
const AGENT_INSTRUCTION_FILES = [
  "CLAUDE.md",
  "codex.md",
  ".cursorrules",
] as const;

/**
 * Strict semver parser. Splits the optional build-metadata suffix
 * (`+build`) per semver spec — build metadata is ignored for
 * precedence — then extracts MAJOR / MINOR / PATCH and an optional
 * dot-separated prerelease tail. Returns null when the input is not
 * a valid semver, which the caller maps to "stamp present but
 * unknown" (DISC-1592 Required Semantics Item 1 future-format
 * tolerance).
 */
interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseSemver(input: string): ParsedSemver | null {
  // Strip build metadata (`+...`) — ignored for precedence per semver spec.
  const plusIdx = input.indexOf("+");
  const core = plusIdx === -1 ? input : input.slice(0, plusIdx);

  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(core);
  if (m === null) return null;

  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

/**
 * Compares two prerelease strings per semver §11. Each is split into
 * dot-separated identifiers; numeric identifiers compare numerically,
 * alphanumeric identifiers compare lexicographically, numeric < alpha
 * when the kinds differ. A shorter prerelease (with all leading
 * identifiers equal) is older.
 */
function comparePrerelease(a: string, b: string): number {
  const ap = a.split(".");
  const bp = b.split(".");
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const x = ap[i];
    const y = bp[i];
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const xv = Number(x);
      const yv = Number(y);
      if (xv !== yv) return xv < yv ? -1 : 1;
    } else if (xNumeric) {
      return -1;
    } else if (yNumeric) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ap.length - bp.length;
}

/**
 * Compares two semver strings. Returns a negative number when `a < b`,
 * positive when `a > b`, zero when equal, or null when either input
 * is not a parseable semver. The null return is what implements the
 * "stamp present but unknown — skip the stale-warning rather than
 * crash" tolerance from SDK-050.
 */
export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease === null && pb.prerelease === null) return 0;
  // A version without prerelease has higher precedence than one with.
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * Reads the truthy-state of `GLASSTRACE_DISABLE_UPGRADE_NOTICE`. The
 * accepted truthy values are `"1"`, `"true"`, `"yes"`
 * (case-insensitive); any other value (including unset or whitespace)
 * leaves the warning enabled.
 */
function isOptedOut(): boolean {
  const raw = process.env.GLASSTRACE_DISABLE_UPGRADE_NOTICE;
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "1" || trimmed === "true" || trimmed === "yes";
}

/**
 * Optional heuristic suppression in non-interactive CI runs (per
 * SDK-050 Required Semantics §2 Item 3). The brief allows — but does
 * not require — suppressing the warning when stderr is not a TTY AND
 * `CI=true` is set in the environment. The combination indicates an
 * automated build (`next build` evaluating `instrumentation.ts`,
 * GitHub Actions matrix runs, etc.) where the warning is noise; an
 * interactive developer run still sees it because either condition
 * fails (TTY present, or CI unset).
 *
 * Implementation notes:
 *   - `process.stderr.isTTY` is `true | undefined`. Coerce to boolean
 *     with `=== true` so non-TTY stderr (piped / redirected / CI) is
 *     classified consistently.
 *   - `CI=true` is the GitHub Actions / many-CI convention; we accept
 *     only the literal `"true"` rather than any truthy value because
 *     the brief named that exact form.
 */
function isQuietCiContext(): boolean {
  const stderrIsTty = process.stderr.isTTY === true;
  if (stderrIsTty) return false;
  return process.env.CI === "true";
}

/**
 * Per-file inspection result. The caller aggregates these and emits
 * one warning if any file is `"stale"`.
 */
type FileState =
  | "absent" // file does not exist or is unreadable
  | "no-section" // file exists but has no managed marker pair
  | "no-stamp" // managed section exists with legacy unstamped marker
  | "current" // managed section exists with stamp >= running SDK
  | "stale" // managed section exists with stamp < running SDK
  | "unknown-stamp"; // stamp present but unparseable as semver

/**
 * Maximum file size (bytes) we will read at SDK init for stale-stamp
 * detection. Realistic agent instruction files are well under 100 KB;
 * 5 MB is generous headroom while bounding the worst-case sync read at
 * `registerGlasstrace()` time. Pathologically large files are treated
 * as `"absent"` — the warning cannot be decided locally, but the SDK
 * will not block on a multi-second sync read either.
 */
const MAX_AGENT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Synchronously inspects a single agent instruction file and reports
 * its state. Best-effort and silent — never throws. Reads only the
 * first marker line by scanning the whole file (small text files
 * make a streaming reader unnecessary; the typical agent-instruction
 * file is well under 100 KB).
 */
function inspectFile(filePath: string, runningSdkVersion: string): FileState {
  let content: string;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "absent";
    if (stat.size > MAX_AGENT_FILE_BYTES) return "absent";
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return "absent";
  }

  const lines = content.split("\n");

  // Walk the file looking for a COMPLETE marker pair (start followed
  // by end). An orphaned/quoted start marker without a matching end
  // is treated as no-section so a hand-edited or truncated file
  // cannot trigger a false stale warning.
  //
  // When multiple start markers appear before the first end marker
  // (e.g. an earlier quoted-example marker line followed by the real
  // managed block), classify based on the MOST RECENT start preceding
  // the end — same anchoring as `findMarkerBoundaries` in inject.ts,
  // so detection here mirrors what the upgrade command will actually
  // replace.
  let lastStart: { stamp: string | null } | null = null;
  let foundEnd = false;
  for (const line of lines) {
    const parsed = parseStartMarkerLine(line);
    if (parsed !== null) {
      lastStart = parsed;
      continue;
    }
    if (lastStart !== null && isEndMarkerLine(line)) {
      foundEnd = true;
      break;
    }
  }

  if (lastStart === null || !foundEnd) {
    return "no-section";
  }

  if (lastStart.stamp === null) {
    return "no-stamp";
  }
  const cmp = compareSemver(lastStart.stamp, runningSdkVersion);
  if (cmp === null) {
    // Stamp present but unparseable (hand-edited, future format).
    // SDK-050 future-format tolerance: skip the warning rather than
    // crash. Upgrade still re-renders correctly via inject.ts.
    return "unknown-stamp";
  }
  return cmp < 0 ? "stale" : "current";
}

/**
 * Inputs for {@link maybeWarnStaleAgentInstructions}.
 */
export interface UpgradeNoticeOptions {
  /**
   * Project root to scan for agent instruction files. Typically
   * `process.cwd()` from the SDK runtime. The hardcoded set of
   * filenames in {@link AGENT_INSTRUCTION_FILES} is joined against
   * this directory.
   */
  projectRoot: string;
  /**
   * The SDK's own version constant (`__SDK_VERSION__`). Compared
   * against the on-disk stamp. Must be a parseable semver; if not,
   * the warning is suppressed (a misbuilt SDK should not emit
   * spurious notices).
   */
  sdkVersion: string;
  /**
   * Test seam — overrides `process.stderr.write` so unit tests can
   * capture the emitted line without touching the real stderr.
   */
  stderrWrite?: (chunk: string) => void;
}

/**
 * Best-effort stale-section check. Emits at most one stderr warning
 * per process boot when any inspected agent instruction file carries
 * a stamp strictly older than the running SDK version.
 *
 * Never throws. No-op in non-Node runtimes (browser / edge), when
 * the opt-out env var is set, when no stamped sections are found,
 * when no stale section is detected, or when this function has
 * already emitted in the current process.
 */
export function maybeWarnStaleAgentInstructions(
  options: UpgradeNoticeOptions,
): void {
  try {
    if (warningEmitted) return;

    // Defensive Node-runtime guard. The module is only imported by
    // `register.ts`, which the F003 edge gate excludes from the edge
    // bundle — but a future re-export change must not regress this
    // contract. Bail silently in any environment lacking the Node
    // basics (process / process.env / stderr).
    if (
      typeof process === "undefined" ||
      typeof process.versions?.node !== "string" ||
      typeof process.env !== "object" ||
      process.env === null
    ) {
      return;
    }

    if (isOptedOut()) return;
    if (isQuietCiContext()) return;

    // Misbuilt SDK guard: an unparseable running version means we
    // cannot meaningfully decide staleness. Stay silent rather than
    // emit a confusing warning.
    if (parseSemver(options.sdkVersion) === null) return;

    const staleFiles: string[] = [];
    for (const fileName of AGENT_INSTRUCTION_FILES) {
      const fullPath = path.join(options.projectRoot, fileName);
      const state = inspectFile(fullPath, options.sdkVersion);
      if (state === "stale") {
        staleFiles.push(fileName);
      }
    }

    if (staleFiles.length === 0) return;

    // Single-line warning. The text mentions the upgrade command and
    // the opt-out env var. File names come from the hardcoded set —
    // never from the on-disk stamp value — so there is no path for
    // arbitrary user content (or terminal escape sequences from a
    // hand-edited stamp) to reach stderr. Phrasing is grammatical
    // for both 1-file and multi-file lists ("section in X" / "section
    // in X, Y" both read cleanly).
    const fileList = staleFiles.join(", ");
    const message =
      `[glasstrace] Glasstrace managed MCP section in ${fileList} was rendered by an older ` +
      `@glasstrace/sdk; run \`npx glasstrace upgrade-instructions\` to refresh ` +
      `(silence with GLASSTRACE_DISABLE_UPGRADE_NOTICE=1).\n`;

    warningEmitted = true;

    if (options.stderrWrite !== undefined) {
      options.stderrWrite(message);
      return;
    }

    // process.stderr is always present on Node, but defend against
    // an exotic embedding where it's been replaced with a non-callable
    // value. Catch any rare write error so the warning path can never
    // throw out of registerGlasstrace().
    try {
      process.stderr.write(message);
    } catch {
      // Swallow — the warning is best-effort.
    }
  } catch {
    // Top-level safety net. Any unexpected error in the upgrade-notice
    // path is suppressed so it cannot affect SDK init or tracing.
  }
}

/**
 * Test-only — clears the once-per-process guard so unit tests can
 * exercise multiple emissions in sequence. Not exported from the
 * public barrel.
 */
export function _resetUpgradeNoticeForTesting(): void {
  warningEmitted = false;
}
