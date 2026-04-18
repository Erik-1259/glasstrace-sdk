import {
  SdkInitResponseSchema,
  SdkCachedConfigSchema,
  DEFAULT_CAPTURE_CONFIG,
} from "@glasstrace/protocol";
import type {
  SdkInitResponse,
  CaptureConfig,
  AnonApiKey,
  ImportGraphPayload,
  SdkHealthReport,
  SdkDiagnosticCode,
} from "@glasstrace/protocol";
import type { ResolvedConfig } from "./env-detection.js";
import { recordInitFailure, recordConfigSync, acknowledgeHealthReport } from "./health-collector.js";
import {
  httpsPostJson,
  HttpsStatusError,
  HttpsTransportError,
  HttpsBodyParseError,
} from "./https-transport.js";

const GLASSTRACE_DIR = ".glasstrace";
const CONFIG_FILE = "config";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const INIT_TIMEOUT_MS = 10_000;

/**
 * Lazily imports `node:fs/promises` and `node:path`. Returns `null` if
 * the modules are unavailable (non-Node environments). Cached after first call.
 */
let fsPathAsyncCache: { fs: typeof import("node:fs/promises"); path: typeof import("node:path") } | null | undefined;

async function loadFsPathAsync(): Promise<{ fs: typeof import("node:fs/promises"); path: typeof import("node:path") } | null> {
  if (fsPathAsyncCache !== undefined) return fsPathAsyncCache;
  try {
    const [fs, path] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    fsPathAsyncCache = { fs, path };
    return fsPathAsyncCache;
  } catch {
    fsPathAsyncCache = null;
    return null;
  }
}

/**
 * Lazily imports synchronous `node:fs` and `node:path` via `require()`.
 * Returns `null` when unavailable. Used by `loadCachedConfig` which is
 * synchronous for startup performance.
 */
function loadFsSyncOrNull(): { readFileSync: typeof import("node:fs").readFileSync; join: typeof import("node:path").join } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    return { readFileSync: fs.readFileSync, join: path.join };
  } catch {
    return null;
  }
}

/**
 * Test-only transport hook. When set, `sendInitRequest` calls this
 * instead of `httpsPostJson`. Enables unit tests to assert that the
 * SDK never routes through `globalThis.fetch` (Next.js patching) by
 * injecting a pure-function transport that never touches the network.
 *
 * Production code never sets this. Reset via `_resetConfigForTesting()`.
 */
type HttpsPostJsonFn = typeof httpsPostJson;
let transportOverride: HttpsPostJsonFn | null = null;

/** In-memory config from the latest successful init response. */
let currentConfig: SdkInitResponse | null = null;

/** Whether the disk cache has already been checked by getActiveConfig(). */
let configCacheChecked = false;

/** Whether the next init call should be skipped (rate-limit backoff). */
let rateLimitBackoff = false;

/** Whether the most recent performInit call completed the success path. */
let lastInitSucceeded = false;

/**
 * Reads and validates a cached config file from `.glasstrace/config`.
 * Returns the parsed `SdkInitResponse` or `null` on any failure,
 * including when `node:fs` is unavailable (non-Node environments).
 */
export function loadCachedConfig(projectRoot?: string): SdkInitResponse | null {
  const modules = loadFsSyncOrNull();
  if (!modules) return null;

  const root = projectRoot ?? process.cwd();
  const configPath = modules.join(root, GLASSTRACE_DIR, CONFIG_FILE);

  try {
    // Use synchronous read for startup performance (this is called during init)
    const content = modules.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    const cached = SdkCachedConfigSchema.parse(parsed);

    // Warn if cache is stale
    const age = Date.now() - cached.cachedAt;
    if (age > TWENTY_FOUR_HOURS_MS) {
      console.warn(
        `[glasstrace] Cached config is ${Math.round(age / 3600000)}h old. Will refresh on next init.`,
      );
    }

    // Parse the response through the schema
    const result = SdkInitResponseSchema.safeParse(cached.response);
    if (result.success) {
      recordConfigSync(cached.cachedAt);
      return result.data;
    }

    console.warn("[glasstrace] Cached config failed validation. Using defaults.");
    return null;
  } catch {
    return null;
  }
}

/**
 * Persists the init response to `.glasstrace/config` using atomic
 * write-temp + rename semantics. Silently skipped when `node:fs` is
 * unavailable (non-Node environments). On I/O failure, logs a warning.
 *
 * Atomicity: the payload is written to `.glasstrace/config.tmp` and then
 * renamed into place. `rename` is atomic on POSIX filesystems, so readers
 * either see the previous valid config or the new valid config — never a
 * truncated or partially-written file (DISC-1247 Scenario 5). If the
 * rename fails, the temp file is cleaned up on a best-effort basis.
 */
export async function saveCachedConfig(
  response: SdkInitResponse,
  projectRoot?: string,
): Promise<void> {
  const modules = await loadFsPathAsync();
  if (!modules) return;

  const root = projectRoot ?? process.cwd();
  const dirPath = modules.path.join(root, GLASSTRACE_DIR);
  const configPath = modules.path.join(dirPath, CONFIG_FILE);
  const tmpPath = `${configPath}.tmp`;

  try {
    await modules.fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    await modules.fs.chmod(dirPath, 0o700);
    const cached = {
      response,
      cachedAt: Date.now(),
    };
    // Write to a sibling temp file first, then atomically rename.
    // Using a sibling (same directory) guarantees the rename stays on
    // the same filesystem, which is required for atomicity.
    await modules.fs.writeFile(tmpPath, JSON.stringify(cached), {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      await modules.fs.chmod(tmpPath, 0o600);
      await modules.fs.rename(tmpPath, configPath);
    } catch (renameErr) {
      // Rename failed — remove the temp file so it doesn't linger.
      try {
        await modules.fs.unlink(tmpPath);
      } catch {
        // Best-effort cleanup; ignore unlink failures.
      }
      throw renameErr;
    }
    // chmod the final path to defend against platforms that don't honor
    // the mode passed to writeFile/rename on first creation.
    await modules.fs.chmod(configPath, 0o600);
  } catch (err) {
    console.warn(
      `[glasstrace] Failed to cache config to ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Sends a POST request to `/v1/sdk/init`.
 * Validates the response against `SdkInitResponseSchema`.
 *
 * Uses `node:https` via {@link httpsPostJson} rather than the global
 * `fetch` because Next.js 16 patches `fetch` for caching/revalidation
 * and can cause the init request to silently hang (DISC-493 Issue 3).
 * Retries transport-level failures (DNS, TCP, TLS) twice with 500ms +
 * 1500ms backoff, capped at a 20-second total deadline. Server responses
 * (HTTP 4xx/5xx) are never retried and are surfaced immediately.
 */
export async function sendInitRequest(
  config: ResolvedConfig,
  anonKey: AnonApiKey | null,
  sdkVersion: string,
  importGraph?: ImportGraphPayload,
  healthReport?: SdkHealthReport,
  diagnostics?: Array<{ code: SdkDiagnosticCode; message: string; timestamp: number }>,
  signal?: AbortSignal,
): Promise<SdkInitResponse> {
  // Determine the API key for auth. Use || (not ??) so empty strings
  // fall through to the anonymous key — defense in depth for DISC-467.
  const effectiveKey = config.apiKey || anonKey;
  if (!effectiveKey) {
    throw new Error("No API key available for init request");
  }

  // Build the request payload
  const payload: Record<string, unknown> = {
    sdkVersion,
  };

  // Straggler linking: if dev key is set AND anonKey is provided
  if (config.apiKey && anonKey) {
    payload.anonKey = anonKey;
  }

  if (config.environment) {
    payload.environment = config.environment;
  }
  if (importGraph) {
    payload.importGraph = importGraph;
  }
  if (healthReport) {
    payload.healthReport = healthReport;
  }
  if (diagnostics) {
    payload.diagnostics = diagnostics;
  }

  const url = `${config.endpoint}/v1/sdk/init`;

  const transport = transportOverride ?? httpsPostJson;
  let result;
  try {
    result = await transport(url, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${effectiveKey}`,
      },
      timeoutMs: INIT_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    if (err instanceof HttpsStatusError) {
      const error = new Error(`Init request failed with status ${err.status}`);
      (error as unknown as Record<string, unknown>).status = err.status;
      throw error;
    }
    if (err instanceof HttpsBodyParseError) {
      // Preserve SyntaxError name so callers can distinguish parse failures
      // (existing test contract uses `name === "SyntaxError"`).
      const cause = err.cause;
      if (cause instanceof SyntaxError) throw cause;
      throw err;
    }
    if (err instanceof HttpsTransportError) {
      // Transport error — surface as-is; callers classify via message/name.
      throw err;
    }
    throw err;
  }

  return SdkInitResponseSchema.parse(result.body);
}

/**
 * Result returned by {@link performInit} when the backend reports an
 * account claim transition. `null` means no claim was present.
 */
export interface InitClaimResult {
  claimResult: NonNullable<SdkInitResponse["claimResult"]>;
}

/**
 * Writes a claimed API key to disk using a fallback chain:
 *   1. `.env.local` — update or create with the new key
 *   2. `.glasstrace/claimed-key` — fallback if `.env.local` is not writable
 *   3. Dashboard message — if all file writes fail (key is never logged)
 *
 * The key value MUST NOT appear in any log output or stderr message.
 * In non-Node environments where `node:fs` is unavailable, falls through
 * directly to the dashboard message (step 3).
 */
export async function writeClaimedKey(
  newApiKey: string,
  projectRoot?: string,
): Promise<void> {
  const modules = await loadFsPathAsync();

  if (modules) {
    const root = projectRoot ?? process.cwd();
    const envLocalPath = modules.path.join(root, ".env.local");

    // Step 1: Try writing to .env.local
    let envLocalWritten = false;
    try {
      let content: string;
      try {
        content = await modules.fs.readFile(envLocalPath, "utf-8");
        // Replace all existing GLASSTRACE_API_KEY lines or append
        if (/^GLASSTRACE_API_KEY=.*/m.test(content)) {
          content = content.replace(
            /^GLASSTRACE_API_KEY=.*$/gm,
            `GLASSTRACE_API_KEY=${newApiKey}`,
          );
        } else {
          // Ensure trailing newline before appending
          if (content.length > 0 && !content.endsWith("\n")) {
            content += "\n";
          }
          content += `GLASSTRACE_API_KEY=${newApiKey}\n`;
        }
      } catch (readErr: unknown) {
        // Only create a new file when the file genuinely does not exist.
        // Other read errors (e.g., permission denied) should not silently
        // overwrite an existing .env.local that we cannot read.
        const code = readErr instanceof Error ? (readErr as NodeJS.ErrnoException).code : undefined;
        if (code !== "ENOENT") {
          throw readErr;
        }
        content = `GLASSTRACE_API_KEY=${newApiKey}\n`;
      }

      await modules.fs.writeFile(envLocalPath, content, { encoding: "utf-8", mode: 0o600 });
      await modules.fs.chmod(envLocalPath, 0o600);
      envLocalWritten = true;
    } catch {
      // .env.local write failed — fall through to step 2
    }

    if (envLocalWritten) {
      try {
        process.stderr.write(
          "[glasstrace] Account claimed! API key written to .env.local. Restart your dev server to use it.\n",
        );
      } catch { /* stderr is best-effort */ }
      return;
    }

    // Step 2: Try writing to .glasstrace/claimed-key
    let claimedKeyWritten = false;
    try {
      const dirPath = modules.path.join(root, GLASSTRACE_DIR);
      await modules.fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
      await modules.fs.chmod(dirPath, 0o700);
      const claimedKeyPath = modules.path.join(dirPath, "claimed-key");
      await modules.fs.writeFile(claimedKeyPath, newApiKey, {
        encoding: "utf-8",
        mode: 0o600,
      });
      await modules.fs.chmod(claimedKeyPath, 0o600);
      claimedKeyWritten = true;
    } catch {
      // .glasstrace write also failed — fall through to step 3
    }

    if (claimedKeyWritten) {
      try {
        process.stderr.write(
          "[glasstrace] Account claimed! API key written to .glasstrace/claimed-key. Copy it to your .env.local file.\n",
        );
      } catch { /* stderr is best-effort */ }
      return;
    }
  }

  // Step 3: All file writes failed (or node:fs unavailable) — log a message WITHOUT the key
  try {
    process.stderr.write(
      "[glasstrace] Account claimed but could not write key to disk. Visit your dashboard settings to rotate and retrieve a new API key.\n",
    );
  } catch { /* stderr is best-effort */ }
}

/**
 * Orchestrates the full init flow: send request, update config, cache result.
 * This function MUST NOT throw.
 *
 * Returns the claim result when the backend reports an account claim
 * transition, or `null` when no claim result is available (including
 * when init is skipped due to rate-limit backoff, missing API key,
 * or request failure). Callers that do not need claim information
 * can safely ignore the return value.
 */
export async function performInit(
  config: ResolvedConfig,
  anonKey: AnonApiKey | null,
  sdkVersion: string,
  healthReport?: SdkHealthReport | null,
): Promise<InitClaimResult | null> {
  lastInitSucceeded = false;

  // Skip if in rate-limit backoff
  if (rateLimitBackoff) {
    rateLimitBackoff = false; // Reset for next call
    return null;
  }

  try {
    const effectiveKey = config.apiKey || anonKey;
    if (!effectiveKey) {
      console.warn("[glasstrace] No API key available for init request.");
      return null;
    }

    // No outer AbortController timeout: `httpsPostJson` enforces a
    // per-attempt timeout (INIT_TIMEOUT_MS = 10s) AND a 20s total
    // deadline across retries. An outer 10s abort would race the first
    // attempt's own timeout and prevent the backoff-retry window from
    // ever running, defeating the transport's retry behavior.
    try {
      // Delegate to sendInitRequest to avoid duplicating fetch logic
      const result = await sendInitRequest(
        config,
        anonKey,
        sdkVersion,
        undefined,
        healthReport ?? undefined,
        undefined,
      );

      // Update in-memory config
      currentConfig = result;
      recordConfigSync(Date.now());
      if (healthReport) {
        acknowledgeHealthReport(healthReport);
      }
      lastInitSucceeded = true;

      // Persist to disk
      await saveCachedConfig(result);

      // Handle account claim transition — write key to disk, never to stderr
      if (result.claimResult) {
        try {
          await writeClaimedKey(result.claimResult.newApiKey);
        } catch {
          // writeClaimedKey handles its own errors internally, but guard
          // against unexpected failures to ensure claimResult is never lost
        }
        return { claimResult: result.claimResult };
      }

      return null;
    } catch (err) {
      recordInitFailure();

      // HttpsTransportError covers DNS/TCP/TLS/timeout from the
      // node:https transport itself — `httpsPostJson` raises timeouts
      // via this error class when its internal deadlines expire.
      if (err instanceof HttpsTransportError) {
        if (/timed out|aborted/i.test(err.message)) {
          console.warn("[glasstrace] ingestion_unreachable: Init request timed out.");
        } else {
          console.warn(`[glasstrace] ingestion_unreachable: ${err.message}`);
        }
        return null;
      }

      // Check for HTTP status errors attached by sendInitRequest
      const status = (err as Record<string, unknown>).status;
      if (status === 401) {
        console.warn(
          "[glasstrace] ingestion_auth_failed: Check your GLASSTRACE_API_KEY.",
        );
        return null;
      }

      if (status === 429) {
        console.warn("[glasstrace] ingestion_rate_limited: Backing off.");
        rateLimitBackoff = true;
        return null;
      }

      if (typeof status === "number" && status >= 400) {
        console.warn(
          `[glasstrace] Init request failed with status ${status}. Using cached config.`,
        );
        return null;
      }

      // Schema validation failure from sendInitRequest.parse
      // NOTE: Health report was already sent to the backend (HTTP 200).
      // Not acknowledging here means the next report will double-count
      // these values. This is intentional — over-reporting is preferable
      // to data loss when the response is unparseable (DISC-1120).
      if (err instanceof Error && err.name === "ZodError") {
        console.warn(
          "[glasstrace] Init response failed validation (schema version mismatch?). Using cached config.",
        );
        return null;
      }

      // Network error or other fetch failure
      console.warn(
        `[glasstrace] ingestion_unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  } catch (err) {
    // Outermost catch — safety net. The inner catch already called
    // recordInitFailure(), so skip here to avoid double-counting (DISC-1121).
    console.warn(
      `[glasstrace] Unexpected init error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

/**
 * Returns the current capture config from the three-tier fallback chain:
 * 1. In-memory config from latest init response
 * 2. File cache (read at most once per process lifetime)
 * 3. DEFAULT_CAPTURE_CONFIG
 *
 * The disk read is cached via `configCacheChecked` to avoid repeated
 * synchronous I/O on the hot path (called by GlasstraceExporter on
 * every span export batch).
 */
export function getActiveConfig(): CaptureConfig {
  // Tier 1: in-memory
  if (currentConfig) {
    return currentConfig.config;
  }

  // Tier 2: file cache (only attempt once)
  if (!configCacheChecked) {
    configCacheChecked = true;
    const cached = loadCachedConfig();
    if (cached) {
      currentConfig = cached;
      return cached.config;
    }
  }

  // Tier 3: defaults
  return { ...DEFAULT_CAPTURE_CONFIG };
}

/**
 * Returns the `linkedAccountId` from the current in-memory init response,
 * or `undefined` if no init response is available or no account is linked.
 *
 * Used by the discovery endpoint to determine whether `claimed: true`
 * should be included in the response.
 */
export function getLinkedAccountId(): string | undefined {
  return currentConfig?.linkedAccountId;
}

/**
 * Returns the `claimResult` from the current in-memory init response,
 * or `undefined` if no init response is available or no claim occurred.
 *
 * Used by the discovery endpoint to detect in-flight claims: a valid
 * init response can include `claimResult` (claim happening NOW) without
 * `linkedAccountId` being set yet.
 */
export function getClaimResult(): SdkInitResponse["claimResult"] {
  return currentConfig?.claimResult;
}

/**
 * Resets the in-memory config store. For testing only.
 */
export function _resetConfigForTesting(): void {
  currentConfig = null;
  configCacheChecked = false;
  rateLimitBackoff = false;
  lastInitSucceeded = false;
  transportOverride = null;
}

/**
 * Installs a test-only transport that replaces the `node:https` path
 * used by `sendInitRequest` and `performInit`. Tests use this to avoid
 * opening real sockets and to assert the SDK never routes through
 * `globalThis.fetch`. Pass `null` to restore the default transport.
 *
 * @internal Test-only. Never called from production code paths.
 */
export function _setTransportForTesting(fn: HttpsPostJsonFn | null): void {
  transportOverride = fn;
}

/**
 * Sets the in-memory config directly. Used by performInit and the orchestrator.
 */
export function _setCurrentConfig(config: SdkInitResponse): void {
  currentConfig = config;
}

/**
 * Returns whether rate-limit backoff is active. For testing only.
 */
export function _isRateLimitBackoff(): boolean {
  return rateLimitBackoff;
}

/**
 * Reads and clears the rate-limit backoff flag.
 * Called by the heartbeat after performInit returns null to detect 429 responses.
 * Returns true if a 429 occurred, false otherwise.
 */
export function consumeRateLimitFlag(): boolean {
  if (rateLimitBackoff) {
    rateLimitBackoff = false;
    return true;
  }
  return false;
}

/**
 * Returns true if the most recent performInit call completed the success path
 * (recordConfigSync + acknowledgeHealthReport were called).
 * Used by backgroundInit to decide whether to start the heartbeat.
 */
export function didLastInitSucceed(): boolean {
  return lastInitSucceeded;
}

/**
 * Result of {@link verifyInitReachable}.
 *
 * - `ok: true` — server acknowledged the init call with a valid, schema-
 *   compliant payload. The anon key (if any) is registered server-side.
 * - `ok: false` with `reason: "transport"` — DNS/TCP/TLS/timeout failure.
 *   No response reached the server (or couldn't be parsed off the wire).
 *   `detail` is the raw cause (e.g. "ECONNREFUSED") with any leading
 *   `fetch failed: ` prefix stripped; callers that render to the user
 *   should add the prefix themselves to avoid doubling it.
 * - `ok: false` with `reason: "rejected"` — HTTP 4xx/5xx status. The
 *   server received the call but declined it. `status` is set.
 * - `ok: false` with `reason: "malformed"` — HTTP 2xx but the body was
 *   not valid JSON or did not match the protocol schema.
 */
export type VerifyInitResult =
  | { ok: true; response: SdkInitResponse }
  | { ok: false; reason: "transport"; detail: string }
  | { ok: false; reason: "rejected"; status: number; detail: string }
  | { ok: false; reason: "malformed"; detail: string };

/**
 * Synchronously verifies that `/v1/sdk/init` is reachable and that the
 * provided anon key (if any) is registered server-side. Unlike
 * {@link performInit}, this function does NOT swallow errors — it
 * classifies them into the three user-actionable categories and
 * returns them.
 *
 * Used by the CLI `init` command to fail loudly when the init request
 * fails (DISC-493 Issue 3, DISC-494), rather than relying on the
 * runtime fire-and-forget call which can silently fail inside a
 * Next.js 16 process.
 *
 * The anon key is NEVER logged by this function. Error `detail`
 * strings are sanitized to the failure class only — the key does not
 * appear in transport, rejection, or malformed messages.
 */
export async function verifyInitReachable(
  config: ResolvedConfig,
  anonKey: AnonApiKey | null,
  sdkVersion: string,
): Promise<VerifyInitResult> {
  try {
    const response = await sendInitRequest(config, anonKey, sdkVersion);
    return { ok: true, response };
  } catch (err) {
    // HTTP status error — server rejected the key.
    const status = (err as Record<string, unknown>).status;
    if (typeof status === "number") {
      return {
        ok: false,
        reason: "rejected",
        status,
        detail: `server returned HTTP ${status}`,
      };
    }

    // Schema validation failure (ZodError) or JSON parse error
    // (SyntaxError). Both mean the server responded but the body is
    // not a shape we can use.
    if (err instanceof Error && (err.name === "ZodError" || err.name === "SyntaxError")) {
      return {
        ok: false,
        reason: "malformed",
        detail: "server returned malformed response",
      };
    }

    // Everything else (transport errors, timeouts, abort, unknown) is
    // classified as transport. `detail` is the raw cause without a
    // `fetch failed:` prefix so the CLI (the only caller that renders
    // this) can format it as `fetch failed: <detail>` without risking
    // the double-prefix that would occur when the underlying error
    // already starts with `fetch failed:` (e.g., `HttpsTransportError`
    // from `sendSingleRequest`).
    const rawMessage = err instanceof Error ? err.message : String(err);
    const detail = rawMessage.startsWith("fetch failed: ")
      ? rawMessage.slice("fetch failed: ".length)
      : rawMessage;
    return { ok: false, reason: "transport", detail };
  }
}
