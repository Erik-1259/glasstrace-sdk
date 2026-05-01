import { createHash } from "node:crypto";
import {
  AnonApiKeySchema,
  DevApiKeySchema,
  type AnonApiKey,
  type DevApiKey,
} from "@glasstrace/protocol";
import { readAnonKey, readClaimedKey } from "./anon-key.js";

/**
 * Glasstrace MCP endpoint embedded in managed MCP configs and used by
 * the runtime claim-refresh path. Lives here (not in `cli/constants.ts`)
 * so the runtime helper can reach it without crossing the runtime/CLI
 * boundary; `cli/constants.ts` re-exports it for one release.
 */
export const MCP_ENDPOINT = "https://api.glasstrace.dev/mcp";

/**
 * Runtime-safe MCP credential and config utilities.
 *
 * This module is loaded into user processes at SDK boot. It must not
 * import from `cli/*` or `agent-detection/*` so the runtime bundle does
 * not pull in CLI scaffolding or filesystem scanners. The boundary is
 * enforced by an import-graph guard test.
 *
 * Internal: not re-exported via `node-entry.ts` or `index.ts`.
 *
 * @module
 */

let fsPathCache:
  | { fs: typeof import("node:fs/promises"); path: typeof import("node:path") }
  | null
  | undefined;

async function loadFsPath(): Promise<
  | { fs: typeof import("node:fs/promises"); path: typeof import("node:path") }
  | null
> {
  if (fsPathCache !== undefined) return fsPathCache;
  try {
    const [fs, path] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    fsPathCache = { fs, path };
    return fsPathCache;
  } catch {
    fsPathCache = null;
    return null;
  }
}

/**
 * Computes a stable identity fingerprint for deduplication purposes.
 * This is NOT password hashing — the input is an opaque token used as
 * a marker identity, not a credential stored for authentication.
 *
 * @internal Exported for unit testing and for `cli/scaffolder.ts`'s
 *   marker writer.
 */
export function identityFingerprint(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

/**
 * Compares two MCP config strings for canonical-JSON equality. Returns
 * `true` when both inputs parse as JSON and produce structurally equal
 * objects after recursive key sorting; falls back to trimmed text
 * comparison for TOML and other non-JSON formats. Returns `false` on
 * parse errors that don't fall through to text comparison.
 *
 * Used to detect manually-edited MCP configs before overwriting them
 * (DISC-1247 Scenario 2c) and as the staleness signal for SDK-managed
 * configs that must be refreshed when the project's effective
 * credential changes.
 *
 * @internal Exported for unit testing only.
 */
export function mcpConfigMatches(
  existingContent: string,
  expectedContent: string,
): boolean {
  const trimmedExpected = expectedContent.trim();

  try {
    const existingParsed: unknown = JSON.parse(existingContent);
    const expectedParsed: unknown = JSON.parse(trimmedExpected);
    return (
      JSON.stringify(canonicalize(existingParsed)) ===
      JSON.stringify(canonicalize(expectedParsed))
    );
  } catch {
    // Fall through to text comparison for TOML and other non-JSON formats.
  }

  return existingContent.trim() === trimmedExpected;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalize(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Parses a `.env.local` file's text content for `GLASSTRACE_API_KEY`,
 * returning the last assignment's value. Empty values
 * (`GLASSTRACE_API_KEY=`) and the `your_key_here` placeholder are
 * filtered out. Surrounding single or double quotes are stripped.
 *
 * The resolver validates the returned value against `DevApiKeySchema`
 * before accepting it; this parser is permissive on purpose so that
 * malformed values can be flagged with a `malformed-env-local`
 * warning rather than silently dropped.
 *
 * @internal Exported for unit testing only.
 */
export function readEnvLocalApiKey(content: string): string | null {
  let last: string | null = null;
  const regex = /^\s*GLASSTRACE_API_KEY\s*=\s*(.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const raw = match[1].trim();
    if (raw === "") continue;
    const unquoted = raw.replace(/^(['"])(.*)\1$/, "$2");
    if (unquoted === "" || unquoted === "your_key_here") continue;
    last = unquoted;
  }
  return last;
}

/**
 * Returns true when the given API key value looks like a claimed
 * developer key (prefix `gt_dev_`). Defensive against leading or
 * trailing whitespace.
 *
 * **This is a prefix-only check, not strict validation.** Use it as a
 * fast path for "looks like a claimed key, do not overwrite". The
 * effective-credential resolver validates with
 * `DevApiKeySchema.safeParse` because a `gt_dev_` prefix alone is not
 * sufficient to authenticate against the backend.
 *
 * @internal Exported for unit testing only.
 */
export function isDevApiKey(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return value.trim().startsWith("gt_dev_");
}

/**
 * Returns true when the given API key value is a fully-valid anonymous
 * API key (matches `AnonApiKeySchema`). Used by `registerViaCli` as a
 * runtime guard so that a `DevApiKey` cannot be passed via process
 * arguments to vendor MCP CLIs (which would expose it via `ps` on
 * multi-user hosts).
 *
 * @internal Exported for unit testing only.
 */
export function isAnonApiKey(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return AnonApiKeySchema.safeParse(value).success;
}

/**
 * The MCP-effective credential, tagged by which on-disk source produced
 * it. `env-local` and `claimed-key` carry a branded `DevApiKey`;
 * `anon` carries a branded `AnonApiKey`. Internal — not re-exported.
 */
export type EffectiveMcpCredential =
  | { source: "env-local"; key: DevApiKey }
  | { source: "claimed-key"; key: DevApiKey }
  | { source: "anon"; key: AnonApiKey };

/**
 * Surfaced when the resolver detected a recoverable anomaly the caller
 * should inform the user about without printing key material.
 *
 * - `malformed-env-local`: `.env.local` set `GLASSTRACE_API_KEY` to a
 *   value that fails `DevApiKeySchema`. The resolver fell through.
 * - `claimed-key-only`: the effective credential came from
 *   `.glasstrace/claimed-key` because `.env.local` had no usable dev
 *   key. Suggest the user copy the key into `.env.local`.
 */
export type ResolveWarning = "malformed-env-local" | "claimed-key-only";

/**
 * The resolved credential plus the on-disk anon key (returned
 * separately so the staleness check does not have to re-read the
 * file) and any warnings the caller should surface to the user.
 */
export interface ResolveResult {
  effective: EffectiveMcpCredential | null;
  anonKey: AnonApiKey | null;
  warnings: ReadonlyArray<ResolveWarning>;
}

/**
 * Resolves the MCP-effective credential for a project, in priority
 * order: `.env.local` `GLASSTRACE_API_KEY` (validated as
 * `DevApiKeySchema`) → `.glasstrace/claimed-key` (validated as
 * `DevApiKeySchema`) → `.glasstrace/anon_key` (`AnonApiKey`). Returns
 * `null` for `effective` only when no source produced a usable key.
 *
 * The function is async because it touches the filesystem. It is
 * called only on the post-claim runtime branch and from the CLI
 * commands `glasstrace init` and `glasstrace mcp add`. It is **not**
 * on the steady-state init path.
 */
export async function resolveEffectiveMcpCredential(
  projectRoot?: string,
): Promise<ResolveResult> {
  const root = projectRoot ?? process.cwd();
  const warnings: ResolveWarning[] = [];

  const envLocalKey = await readEnvLocalDevKey(root, warnings);
  const claimedKey = envLocalKey === null ? await readClaimedKey(root) : null;
  const anonKey = await readAnonKey(root);

  let effective: EffectiveMcpCredential | null = null;
  if (envLocalKey !== null) {
    effective = { source: "env-local", key: envLocalKey };
  } else if (claimedKey !== null) {
    effective = { source: "claimed-key", key: claimedKey };
    warnings.push("claimed-key-only");
  } else if (anonKey !== null) {
    effective = { source: "anon", key: anonKey };
  }

  return { effective, anonKey, warnings };
}

async function readEnvLocalDevKey(
  root: string,
  warnings: ResolveWarning[],
): Promise<DevApiKey | null> {
  const modules = await loadFsPath();
  if (!modules) return null;

  const envPath = modules.path.join(root, ".env.local");
  let content: string;
  try {
    content = await modules.fs.readFile(envPath, "utf-8");
  } catch {
    return null;
  }

  const raw = readEnvLocalApiKey(content);
  if (raw === null) return null;

  const parsed = DevApiKeySchema.safeParse(raw);
  if (!parsed.success) {
    warnings.push("malformed-env-local");
    return null;
  }
  return parsed.data;
}

/**
 * Source label for the credential a marker file describes.
 *
 * @internal
 */
export type MarkerCredentialSource = "env-local" | "claimed-key" | "anon";

/**
 * Descriptor passed to {@link writeMcpMarker} and matched by
 * {@link readMcpMarker}. `credentialHash` is the
 * `identityFingerprint` of the credential actually written into the
 * managed MCP config — never the credential itself.
 *
 * @internal
 */
export interface MarkerTarget {
  credentialSource: MarkerCredentialSource;
  credentialHash: string;
}

/**
 * Normalized state of a `.glasstrace/mcp-connected` marker on disk.
 *
 * - `absent`: no marker file present.
 * - `valid`: a v1 or v2 marker that parsed cleanly. v1 markers are
 *   reported as `credentialSource = "anon"` with `credentialHash`
 *   taken from the legacy `keyHash` field (the v1 schema can only
 *   describe an anon credential).
 * - `unknown-version`: the marker has `version > 2`. Treat as
 *   not-configured so a future SDK that wrote the marker doesn't
 *   block this SDK from refreshing.
 * - `corrupted`: parse failure or schema mismatch. Treat as
 *   not-configured.
 *
 * @internal
 */
export type MarkerState =
  | { status: "absent" }
  | { status: "valid"; credentialSource: MarkerCredentialSource; credentialHash: string }
  | { status: "unknown-version" }
  | { status: "corrupted" };

const MCP_MARKER_FILE = "mcp-connected";
const GLASSTRACE_DIR = ".glasstrace";

/**
 * Reads `.glasstrace/mcp-connected` and returns its normalized state.
 * Used by `mcp add` (marker-mismatch detection) and by
 * {@link writeMcpMarker} (skip-if-match optimization).
 *
 * Reader rules per the design (`SDK-034 D3`):
 * - `version === undefined` → v1: `{ keyHash, configuredAt }`. Mapped
 *   to `credentialSource: "anon"`, `credentialHash: keyHash`. v1's
 *   `keyHash` is itself produced by `identityFingerprint`, so the
 *   format matches v2 without conversion.
 * - `version === 2` → v2 reader.
 * - `version > 2` → `unknown-version` (conservative-fail).
 * - Parse failure → `corrupted` (conservative-fail).
 *
 * @internal Exported for unit testing only.
 */
export async function readMcpMarker(projectRoot?: string): Promise<MarkerState> {
  const root = projectRoot ?? process.cwd();
  const modules = await loadFsPath();
  if (!modules) return { status: "absent" };

  const markerPath = modules.path.join(root, GLASSTRACE_DIR, MCP_MARKER_FILE);
  let content: string;
  try {
    content = await modules.fs.readFile(markerPath, "utf-8");
  } catch {
    return { status: "absent" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { status: "corrupted" };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { status: "corrupted" };
  }

  const obj = parsed as Record<string, unknown>;
  const version = obj["version"];

  if (version === undefined) {
    // v1: { keyHash, configuredAt }
    const keyHash = obj["keyHash"];
    if (typeof keyHash !== "string" || keyHash === "") {
      return { status: "corrupted" };
    }
    return {
      status: "valid",
      credentialSource: "anon",
      credentialHash: keyHash,
    };
  }

  if (version === 2) {
    const source = obj["credentialSource"];
    const hash = obj["credentialHash"];
    if (
      (source !== "env-local" && source !== "claimed-key" && source !== "anon") ||
      typeof hash !== "string" ||
      hash === ""
    ) {
      return { status: "corrupted" };
    }
    return {
      status: "valid",
      credentialSource: source,
      credentialHash: hash,
    };
  }

  if (typeof version === "number" && version > 2) {
    return { status: "unknown-version" };
  }

  return { status: "corrupted" };
}

/**
 * Writes a v2 `.glasstrace/mcp-connected` marker. Returns `true` when
 * the marker was created or updated, `false` when an existing marker
 * already records the same `(credentialSource, credentialHash)` pair
 * and was left untouched.
 *
 * Writer always emits v2 with `version: 2`. The legacy `keyHash`
 * field is intentionally omitted from new writes — v1 readers ignore
 * unknown fields and the duplicate would diverge over time. v3+ and
 * corrupted markers are unconditionally overwritten.
 *
 * The directory is created with `0o700` and the file with `0o600`,
 * matching existing scaffolder behavior.
 *
 * @internal Exported for unit testing only.
 */
export async function writeMcpMarker(
  projectRoot: string,
  target: MarkerTarget,
): Promise<boolean> {
  const modules = await loadFsPath();
  if (!modules) return false;

  const dirPath = modules.path.join(projectRoot, GLASSTRACE_DIR);
  const markerPath = modules.path.join(dirPath, MCP_MARKER_FILE);

  const state = await readMcpMarker(projectRoot);
  if (
    state.status === "valid" &&
    state.credentialSource === target.credentialSource &&
    state.credentialHash === target.credentialHash
  ) {
    return false;
  }

  await modules.fs.mkdir(dirPath, { recursive: true, mode: 0o700 });

  const body = JSON.stringify(
    {
      version: 2,
      credentialSource: target.credentialSource,
      credentialHash: target.credentialHash,
      configuredAt: new Date().toISOString(),
    },
    null,
    2,
  );

  await modules.fs.writeFile(markerPath, body, { mode: 0o600 });
  // writeFile mode only applies on creation on some platforms.
  await modules.fs.chmod(markerPath, 0o600);
  return true;
}

const MCP_CONFIG_FILE = "mcp.json";

/**
 * The set of outcomes the runtime claim-refresh helper can produce.
 *
 * - `rewrote`: `.glasstrace/mcp.json` matched the SDK-shaped output
 *   for the on-disk anon key, was rewritten with the effective
 *   credential, and the marker was updated.
 * - `preserved`: `.glasstrace/mcp.json` exists but does not match the
 *   SDK-shaped output for the on-disk anon key. The file is left
 *   untouched (the user may have hand-edited it). The marker is not
 *   touched.
 * - `absent`: `.glasstrace/mcp.json` does not exist (`ENOENT`), or
 *   no anon key is on disk so there is nothing to compare against. A
 *   project without an anon key never had an SDK-shaped `mcp.json`
 *   written by the runtime path, so this branch is a true no-op.
 * - `skipped-anon-source`: the effective credential is `null` or its
 *   source is `"anon"`. Either way, there is no claim transition to
 *   refresh for. Caller should generally gate on
 *   `effective.source !== "anon"` before invoking the helper; this
 *   branch is the runtime-side belt-and-suspenders.
 * - `skipped-not-persisted`: never reached in practice — the caller
 *   in `init-client.ts` gates on `writeClaimedKey`'s `persisted` not
 *   being `"none"`. The variant exists so an exhaustive switch in
 *   the caller stays exhaustive if the gate is removed.
 *
 * @internal
 */
export type RuntimeRefreshAction =
  | "rewrote"
  | "preserved"
  | "absent"
  | "skipped-anon-source"
  | "skipped-not-persisted";

let refreshNudgeEmitted = false;

/**
 * @internal Exported for unit testing only — resets the per-process
 *   "refresh nudge already emitted" flag.
 */
export function __resetRefreshNudgeForTest(): void {
  refreshNudgeEmitted = false;
}

/**
 * Emits a single redacted stderr line announcing the MCP config
 * refresh. Deduplicated per process via a module-level flag — a
 * second call within the same process is a no-op. Cross-process
 * dedup (the same user running `mcp add` in another terminal moments
 * later) is explicitly out of scope.
 */
function emitRefreshNudge(persistedSource: "env-local" | "claimed-key"): void {
  if (refreshNudgeEmitted) return;
  refreshNudgeEmitted = true;
  try {
    if (persistedSource === "claimed-key") {
      process.stderr.write(
        "[glasstrace] MCP config refreshed for the new credential. " +
          "Copy .glasstrace/claimed-key into .env.local so Codex can pick it up on next restart.\n",
      );
    } else {
      process.stderr.write(
        "[glasstrace] MCP config refreshed for the new credential.\n",
      );
    }
  } catch {
    // stderr is best-effort; refresh outcome must not depend on it.
  }
}

/**
 * Returns the SDK-shaped JSON for `.glasstrace/mcp.json` (the generic
 * MCP config used at runtime). Inlined here — and intentionally not
 * imported from `agent-detection/configs.ts` — because the runtime
 * path must not pull `agent-detection` into the runtime bundle. The
 * shape matches what `generateMcpConfig({ name: "generic", ... },
 * endpoint, bearer)` would produce. If the agent-detection version
 * diverges, the staleness check stops detecting SDK-managed configs;
 * a regression test against `generateMcpConfig`'s "generic" branch
 * lives in `tests/unit/sdk/mcp-runtime.test.ts`.
 */
function genericMcpConfigContent(endpoint: string, bearer: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        glasstrace: {
          url: endpoint,
          headers: {
            Authorization: `Bearer ${bearer}`,
          },
        },
      },
    },
    null,
    2,
  );
}

/**
 * Refreshes `.glasstrace/mcp.json` after a successful account claim
 * transition has persisted a dev/account credential to disk (via
 * `writeClaimedKey`). The file is rewritten only when its content
 * matches the SDK-shaped output for the project's on-disk anon key
 * (canonical-JSON equivalence via `mcpConfigMatches` — whitespace and
 * key order are normalised before comparison). User-edited or
 * third-party `mcp.json` content is preserved.
 *
 * Atomic write protocol: write the replacement to a sibling temp
 * path, set `0o600`, then `rename` into place. This matches the
 * existing pattern at `init-client.ts` for `.glasstrace/config`,
 * `anon-key.ts` for `.glasstrace/anon_key`, and `runtime-state.ts`.
 * The temp must be on the same filesystem as the destination for the
 * `rename` to be atomic.
 *
 * The helper is invoked only on the post-claim runtime branch (see
 * `init-client.ts` `performInit`) and never on the steady-state init
 * path. It must not throw — failures during write/chmod/rename or
 * marker update surface as `"preserved"` so the caller's
 * `claimResult` return is preserved. The temp file is best-effort
 * cleaned up on failure to avoid leaving stale `.tmp` siblings on
 * disk.
 *
 * @internal Exported for unit testing only; not re-exported from
 *   `node-entry.ts` or `index.ts`.
 */
export async function refreshGenericMcpConfigAtRuntime(
  projectRoot: string,
  effective: EffectiveMcpCredential | null,
  anonKeyOnDisk: AnonApiKey | null,
): Promise<{ action: RuntimeRefreshAction }> {
  if (effective === null || effective.source === "anon") {
    return { action: "skipped-anon-source" };
  }

  // Dev-key-only project (no .glasstrace/anon_key on disk): the
  // staleness check has nothing to compare against. The SDK never
  // wrote mcp.json without an anon key, so there is nothing to
  // refresh.
  if (anonKeyOnDisk === null) {
    return { action: "absent" };
  }

  const modules = await loadFsPath();
  if (!modules) return { action: "absent" };

  const dirPath = modules.path.join(projectRoot, GLASSTRACE_DIR);
  const configPath = modules.path.join(dirPath, MCP_CONFIG_FILE);
  const tmpPath = configPath + ".tmp";

  let existing: string;
  try {
    existing = await modules.fs.readFile(configPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { action: "absent" };
    }
    return { action: "preserved" };
  }

  const expectedAnon = genericMcpConfigContent(MCP_ENDPOINT, anonKeyOnDisk);
  if (!mcpConfigMatches(existing, expectedAnon)) {
    return { action: "preserved" };
  }

  // SDK-managed and stale. Replace atomically. Any failure in the
  // write/chmod/rename or marker update path must produce a non-throw
  // outcome so the caller's claimResult return is preserved; the
  // .tmp sibling is best-effort cleaned up.
  const replacement = genericMcpConfigContent(MCP_ENDPOINT, effective.key);
  try {
    await modules.fs.writeFile(tmpPath, replacement, { mode: 0o600 });
    await modules.fs.chmod(tmpPath, 0o600);
    await modules.fs.rename(tmpPath, configPath);

    await writeMcpMarker(projectRoot, {
      credentialSource: effective.source,
      credentialHash: identityFingerprint(effective.key),
    });
  } catch {
    try {
      await modules.fs.unlink(tmpPath);
    } catch {
      // Tmp may not exist (rename succeeded, marker write failed) or
      // unlink itself may fail; either way nothing else to do.
    }
    return { action: "preserved" };
  }

  emitRefreshNudge(effective.source);

  return { action: "rewrote" };
}
