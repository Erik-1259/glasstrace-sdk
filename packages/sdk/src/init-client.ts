import {
  SdkInitResponseSchema,
  SdkCachedConfigSchema,
  DEFAULT_CAPTURE_CONFIG,
} from "@glasstrace/protocol";
import type {
  SdkInitResponse,
  CaptureConfig,
  CaptureFidelity,
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
import {
  resolveEffectiveMcpCredential,
  refreshGenericMcpConfigAtRuntime,
} from "./mcp-runtime.js";
import { atomicWriteFile } from "./atomic-write.js";
import {
  getActiveConfigResponse,
  getActiveConfigOrigin,
  setActiveConfig,
  isConfigCacheChecked,
  markConfigCacheChecked,
  getStoredAttrHmacKey,
  _resetActiveConfigForTesting,
  type ActiveConfigOrigin,
} from "./active-config-store.js";
import { decisionTrace, decisionTraceEnabled } from "./decision-trace.js";

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports, glasstrace/no-unguarded-node-require -- guarded by the surrounding try/catch in `loadFsSyncOrNull`; throw returns `null`, callers (e.g. `loadCachedConfig`) treat it as no cached config (DISC-1555).
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports, glasstrace/no-unguarded-node-require -- guarded by the same try/catch as the preceding `node:fs` require (DISC-1555).
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

// The resolved active capture-config (`currentConfig`) and the once-per-
// process disk-cache-checked flag (`configCacheChecked`) live in the
// `active-config-store` globalThis singleton, not in module-level state.
// Under Turbopack `next dev` HMR and the edge/node bundle split the
// bundler can evaluate more than one copy of this module, and plain
// module-level state would let the copy that applies the served config
// diverge from the copy the in-request emitter reads — silently dropping
// capture at the call site. The singleton makes every bundle instance
// share one record. See `active-config-store.ts`.

/** Whether the next init call should be skipped (rate-limit backoff). */
let rateLimitBackoff = false;

/** Whether the most recent performInit call completed the success path. */
let lastInitSucceeded = false;

/**
 * Normalize a capture config for the on-disk cache. The per-account
 * `attrHmacKey` secret is never persisted, and a `full` posture without that
 * key is invalid on disk — a cold start that loaded it would make every
 * id-only Prisma query record a spurious `unhashed_id` omission — so `full` is
 * downgraded to `strict`. Applied on both write and read, so a cache written
 * by an older SDK (which may hold `full` from the pre-existing schema) is
 * normalized on load too. Returns the input unchanged when already clean.
 */
function normalizeCachedCaptureConfig(config: CaptureConfig): CaptureConfig {
  if (config.attrHmacKey === undefined && config.captureFidelity !== "full") {
    return config;
  }
  const normalized: CaptureConfig = { ...config };
  delete normalized.attrHmacKey;
  if (normalized.captureFidelity === "full") {
    normalized.captureFidelity = "strict";
  }
  return normalized;
}

/**
 * Interprets a candidate init-response value with fail-closed tolerance for
 * the optional result-evidence capability envelope. A value that satisfies
 * the full strict schema parses as-is. When strict parsing fails and the
 * value carries a `config.resultEvidenceCapabilities` member, one retry
 * re-parses the identical value with only that member removed — so a
 * response whose sole defect is a malformed, partial, unknown-member, or
 * future-version envelope still applies, with both result-evidence
 * capabilities unavailable (envelope absent on the stored config). Nothing
 * else is repaired: a response invalid anywhere outside the envelope fails
 * the retry identically and stays rejected.
 *
 * Internal: the exported {@link sendInitRequest} and
 * {@link loadCachedConfig} direct-call contracts stay strict; this
 * tolerance applies only behind the active-configuration application
 * boundary (`performInit`, the lazy cache promotion, and the eager
 * register-time cache application). Nonthrowing for any input the
 * surrounding config handling can produce; a structurally valid envelope is
 * compatibility configuration, not proof of server provenance.
 */
function parseInitResponseWithEnvelopeTolerance(
  body: unknown,
): SdkInitResponse | null {
  const strict = SdkInitResponseSchema.safeParse(body);
  if (strict.success) return strict.data;
  if (body === null || typeof body !== "object") return null;
  const config = (body as Record<string, unknown>).config;
  if (config === null || typeof config !== "object") return null;
  if (!("resultEvidenceCapabilities" in config)) return null;
  const { resultEvidenceCapabilities: _omit, ...configRest } =
    config as Record<string, unknown>;
  void _omit;
  const retry = SdkInitResponseSchema.safeParse({ ...body, config: configRest });
  return retry.success ? retry.data : null;
}

/**
 * Shared implementation of the cached-config read. `tolerant` selects the
 * response interpretation: strict schema parsing for the public
 * {@link loadCachedConfig}, or envelope-tolerant interpretation (see
 * {@link parseInitResponseWithEnvelopeTolerance}) for the internal
 * application-boundary loader.
 */
function loadCachedConfigCore(
  projectRoot: string | undefined,
  tolerant: boolean,
): SdkInitResponse | null {
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
    const result = tolerant
      ? parseInitResponseWithEnvelopeTolerance(cached.response)
      : (() => {
          const strict = SdkInitResponseSchema.safeParse(cached.response);
          return strict.success ? strict.data : null;
        })();
    if (result !== null) {
      recordConfigSync(cached.cachedAt);
      return {
        ...result,
        config: normalizeCachedCaptureConfig(result.config),
      };
    }

    console.warn("[glasstrace] Cached config failed validation. Using defaults.");
    return null;
  } catch {
    return null;
  }
}

/**
 * Reads and validates a cached config file from `.glasstrace/config`.
 * Returns the parsed `SdkInitResponse` or `null` on any failure,
 * including when `node:fs` is unavailable (non-Node environments).
 *
 * Strict: a cached response that fails the full schema — including one
 * whose only defect is an invalid result-evidence capability envelope —
 * returns `null`. The envelope-tolerant interpretation is applied only
 * behind the active-configuration application boundary, not on this
 * public direct-call surface.
 */
export function loadCachedConfig(projectRoot?: string): SdkInitResponse | null {
  return loadCachedConfigCore(projectRoot, false);
}

/**
 * Envelope-tolerant variant of {@link loadCachedConfig} for the
 * active-configuration application boundary (the lazy cache promotion in
 * {@link getActiveConfig}'s resolution and the eager register-time cache
 * application). A cached response whose only defect is an invalid
 * result-evidence capability envelope applies with both capabilities
 * unavailable; any other invalid cache still returns `null`.
 *
 * @internal Not exported from the package barrel.
 */
export function loadCachedConfigTolerant(
  projectRoot?: string,
): SdkInitResponse | null {
  return loadCachedConfigCore(projectRoot, true);
}

/**
 * Persists the init response to `.glasstrace/config` using the SDK 2.0
 * atomic-write protocol (`tmp + fsync(tmp) + rename + fsync(parent)`).
 * Silently skipped when `node:fs` is unavailable (non-Node environments).
 * On I/O failure, logs a warning.
 *
 * Atomicity: the payload is written to `.glasstrace/config.tmp`, fsynced
 * to durable storage, then renamed into place; the parent directory is
 * fsynced last so the rename survives an immediate crash. `rename` is
 * atomic on POSIX filesystems, so readers either see the previous valid
 * config or the new valid config — never a truncated or partially-written
 * file. If any step fails, the temp file is
 * cleaned up on a best-effort basis.
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

  try {
    await modules.fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    await modules.fs.chmod(dirPath, 0o700);
    // Strip the per-account HMAC secret (a tenant secret that must never reach
    // disk) and downgrade an unkeyed `full` posture before persisting — see
    // normalizeCachedCaptureConfig.
    const cached = {
      response: {
        ...response,
        config: normalizeCachedCaptureConfig(response.config),
      },
      cachedAt: Date.now(),
    };
    // Atomic write per SDK 2.0 §4.3: tmp + fsync(tmp) + rename +
    // fsync(parent). Sibling temp guarantees same-filesystem rename
    // (atomic per POSIX). The helper best-effort cleans up the tmp
    // file on failure (DISC-1247 Scenario 5).
    await atomicWriteFile(configPath, JSON.stringify(cached), {
      encoding: "utf-8",
      mode: 0o600,
    });
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
 * and can cause the init request to silently hang.
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
  return SdkInitResponseSchema.parse(
    await sendInitRequestBody(
      config,
      anonKey,
      sdkVersion,
      importGraph,
      healthReport,
      diagnostics,
      signal,
    ),
  );
}

/**
 * Transport half of {@link sendInitRequest}: performs the POST and error
 * classification, returning the raw parsed-JSON response body without
 * schema validation. The public {@link sendInitRequest} applies the strict
 * schema; {@link performInit} applies the envelope-tolerant interpretation
 * at the application boundary. Internal — keeping one transport path means
 * the strict and tolerant consumers cannot drift in error classification.
 */
async function sendInitRequestBody(
  config: ResolvedConfig,
  anonKey: AnonApiKey | null,
  sdkVersion: string,
  importGraph?: ImportGraphPayload,
  healthReport?: SdkHealthReport,
  diagnostics?: Array<{ code: SdkDiagnosticCode; message: string; timestamp: number }>,
  signal?: AbortSignal,
): Promise<unknown> {
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

  return result.body;
}

/**
 * Result returned by {@link performInit} when the backend reports an
 * account claim transition. `null` means no claim was present.
 */
export interface InitClaimResult {
  claimResult: NonNullable<SdkInitResponse["claimResult"]>;
}

/**
 * Result of {@link writeClaimedKey}. The discriminator tells the
 * caller which on-disk source the key now lives at — and, if both
 * file writes failed, that no refresh of dependent state should be
 * attempted because there is no on-disk credential to back it.
 */
export interface WriteClaimedKeyResult {
  persisted: "env-local" | "claimed-key" | "none";
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
 *
 * Returns a {@link WriteClaimedKeyResult} so the caller can gate
 * downstream actions (specifically: managed MCP config refresh) on
 * the key actually having reached disk. Returning `persisted: "none"`
 * means the SDK could not write the key anywhere; refreshing
 * `.glasstrace/mcp.json` from the new key would put it out of sync
 * with the credential the runtime can actually read on the next
 * cold start.
 */
export async function writeClaimedKey(
  newApiKey: string,
  projectRoot?: string,
): Promise<WriteClaimedKeyResult> {
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
      return { persisted: "env-local" };
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
      return { persisted: "claimed-key" };
    }
  }

  // Step 3: All file writes failed (or node:fs unavailable) — log a message WITHOUT the key
  try {
    process.stderr.write(
      "[glasstrace] Account claimed but could not write key to disk. Visit your dashboard settings to rotate and retrieve a new API key.\n",
    );
  } catch { /* stderr is best-effort */ }
  return { persisted: "none" };
}

/**
 * Orchestrates the full init flow: send request, update config, cache result.
 * This function MUST NOT throw.
 *
 * Response interpretation is envelope-tolerant: a response whose only
 * defect is an invalid optional result-evidence capability envelope still
 * applies, with both result-evidence capabilities unavailable. A response
 * invalid anywhere else is rejected exactly as before. The strict
 * {@link sendInitRequest} direct-call contract is unaffected.
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

  // Guard flag: prevents recordInitFailure() from being called twice if the
  // inner catch body itself throws (e.g., an unexpected error in console.warn
  // or the instanceof checks). Without this flag, the outer safety-net catch
  // would call recordInitFailure() a second time, inflating initFailures in
  // the health report. Fix for DISC-1121.
  let failureRecorded = false;

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
      // Delegate to the shared transport path to avoid duplicating fetch
      // logic, then interpret the body with envelope tolerance: a response
      // whose only defect is an invalid result-evidence capability envelope
      // still applies (with both capabilities unavailable) instead of
      // discarding the whole otherwise-valid config. A response invalid
      // anywhere else re-parses strictly so the existing ZodError
      // classification below is preserved byte-for-byte.
      const body = await sendInitRequestBody(
        config,
        anonKey,
        sdkVersion,
        undefined,
        healthReport ?? undefined,
        undefined,
      );
      const result =
        parseInitResponseWithEnvelopeTolerance(body) ??
        SdkInitResponseSchema.parse(body);

      // Update the shared active config (visible to every bundle instance)
      setActiveConfig(result);
      recordConfigSync(Date.now());
      if (healthReport) {
        acknowledgeHealthReport(healthReport);
      }
      lastInitSucceeded = true;

      // Persist to disk
      await saveCachedConfig(result);

      // Handle account claim transition — write key to disk, never to stderr
      if (result.claimResult) {
        let persisted: WriteClaimedKeyResult["persisted"] = "none";
        try {
          const w = await writeClaimedKey(result.claimResult.newApiKey);
          persisted = w.persisted;
        } catch {
          // writeClaimedKey handles its own errors internally, but guard
          // against unexpected failures to ensure claimResult is never lost
        }

        // When the claimed key actually reached disk, refresh the
        // managed `.glasstrace/mcp.json` (if SDK-shaped) so MCP queries
        // start using the same credential ingestion now writes traces
        // with. Refresh failure must not lose claimResult — wrap the
        // whole thing in its own try/catch.
        if (persisted !== "none") {
          try {
            const resolved = await resolveEffectiveMcpCredential();
            await refreshGenericMcpConfigAtRuntime(
              process.cwd(),
              resolved.effective,
              resolved.anonKey,
            );
          } catch {
            // Refresh failure leaves the existing managed config in
            // place. The next CLI-driven `glasstrace mcp add` run will
            // detect the marker mismatch and prompt a re-run.
          }
        }

        return { claimResult: result.claimResult };
      }

      return null;
    } catch (err) {
      recordInitFailure();
      failureRecorded = true;

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
    // Outermost catch — safety net for unexpected throws from the inner catch
    // body itself (e.g., an error in console.warn or instanceof checks).
    // Only record the failure if the inner catch did not already do so (DISC-1121).
    if (!failureRecorded) {
      recordInitFailure();
    }
    // Guard console.warn itself: performInit MUST NOT throw. If console.warn
    // throws here (the same failure mode this catch was added to handle), swallow
    // silently rather than violating the "never throws" contract.
    try {
      console.warn(
        `[glasstrace] Unexpected init error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch { /* best-effort logging; never propagate */ }
  }

  return null;
}

/**
 * Resolves the current capture config from the three-tier fallback chain:
 * 1. In-memory config from latest init response
 * 2. File cache (read at most once per process lifetime)
 * 3. DEFAULT_CAPTURE_CONFIG
 *
 * Internal: the returned object may still carry the per-account `attrHmacKey`
 * secret, so it must not be handed to callers outside this module. The disk
 * read is cached via the shared store's cache-checked flag to avoid repeated
 * synchronous I/O on the hot path (called by GlasstraceExporter on every span
 * export batch). State is read through the `active-config-store` singleton so
 * every bundle instance resolves the same config.
 */
function resolveActiveConfig(): CaptureConfig {
  // Tier 1: in-memory (shared across bundle instances)
  const current = getActiveConfigResponse();
  if (current) {
    // Decision trace (hot path): which fallback tier produced this config.
    // The in-memory store holds BOTH a live server response and a promoted
    // disk cache (the cache is promoted into the store on first read), so the
    // true tier comes from the record's origin — not its mere presence — to
    // keep a promoted cache reporting `cached` rather than `served`. Call-site
    // guarded so nothing is built when OFF; keyed by the closed tier outcome
    // (three values) so it stays bounded and re-emits once per tier as init
    // progresses (default → cached → served).
    if (decisionTraceEnabled()) {
      const tier = getActiveConfigOrigin() === "cache" ? "cached" : "served";
      decisionTrace("config.tier", tier, {
        oneShotKey: `config.tier:${tier}`,
      });
    }
    return current.config;
  }

  // Tier 2: file cache (only attempt once per process). The application
  // boundary uses the envelope-tolerant loader: a cached response whose only
  // defect is an invalid capability envelope still applies (capabilities
  // unavailable) rather than downgrading the whole config to defaults. The
  // public direct-call `loadCachedConfig` stays strict.
  if (!isConfigCacheChecked()) {
    markConfigCacheChecked();
    const cached = loadCachedConfigTolerant();
    if (cached) {
      // Promote the disk cache into the shared store tagged with its `cache`
      // origin, so a subsequent read takes the tier-1 branch but still reports
      // `cached` (not `served`) — the promotion must not masquerade as a live
      // server config.
      setActiveConfig(cached, "cache");
      if (decisionTraceEnabled()) {
        decisionTrace("config.tier", "cached", {
          oneShotKey: "config.tier:cached",
        });
      }
      return cached.config;
    }
  }

  // Tier 3: defaults
  if (decisionTraceEnabled()) {
    decisionTrace("config.tier", "default", {
      oneShotKey: "config.tier:default",
    });
  }
  return { ...DEFAULT_CAPTURE_CONFIG };
}

/**
 * Returns the active capture config with the per-account `attrHmacKey` secret
 * redacted. This is the public getter (exported from the package barrel), so
 * application code importing the SDK can never read the tenant secret through
 * it. The passive value-capture adapter reads the key via the internal
 * {@link getAttrHmacKey} accessor instead.
 *
 * The shared store no longer carries the secret in the config object (it is
 * split into the active-config record's closure holder on apply), so this
 * redaction is a defensive safety net for any path that surfaces a config still
 * holding the field — it is kept to preserve the invariant regardless of how
 * the config reaches here.
 *
 * The returned object is always a fresh copy (including the nested
 * result-evidence capability envelope), so caller-side mutation of a
 * returned config can never change the stored state that later reads and
 * per-operation snapshots observe.
 */
export function getActiveConfig(): CaptureConfig {
  const config = resolveActiveConfig();
  const copy: CaptureConfig = { ...config };
  delete copy.attrHmacKey;
  if (copy.resultEvidenceCapabilities !== undefined) {
    copy.resultEvidenceCapabilities = { ...copy.resultEvidenceCapabilities };
  }
  return copy;
}

/**
 * Provider-neutral result-evidence capability state as one immutable
 * snapshot: the accepted wire version (`1`, or `null` when no valid
 * version-1 envelope is active) and the two independent availability bits.
 * Absence, a cleared config, the built-in defaults, or any envelope the
 * application boundary stripped as invalid all present as
 * `{ wireVersion: null, aggregateScalars: false, boundedRows: false }`.
 */
export interface ResultEvidenceCapabilityState {
  readonly wireVersion: 1 | null;
  readonly aggregateScalars: boolean;
  readonly boundedRows: boolean;
}

/**
 * One coherent, immutable view of every dynamic config value a
 * result-evidence producer uses during a single operation: the master
 * side-effect capture switch, the fidelity posture, the capability state,
 * and the identifier-key state of the same config generation. Provider
 * policy and recording-span admission are deliberately NOT part of this
 * view — an adapter combines its own local policy and span check with this
 * one dynamic view at its operation boundary.
 *
 * The view is frozen and aliases no mutable store state: the scalar fields
 * are copied, the capability object is freshly created, and the
 * identifier key is captured in a closure at snapshot time — so
 * `JSON.stringify` of a view never carries the key, and a later config
 * refresh or key rotation never changes a view already taken.
 */
export interface OperationConfigView {
  readonly sideEffectEvidence: boolean;
  readonly captureFidelity: CaptureFidelity;
  readonly resultEvidence: ResultEvidenceCapabilityState;
  /**
   * The per-account identifier key of this view's config generation, or
   * `undefined` when none is provisioned. A closure rather than a field so
   * the raw secret stays off the view's enumerable surface.
   */
  readonly readAttrHmacKey: () => string | undefined;
}

/**
 * The unavailable capability state: no accepted wire version, both
 * capabilities off. Shared by the no-envelope snapshot path and the
 * fail-closed view so the two cannot drift.
 */
const UNAVAILABLE_RESULT_EVIDENCE: ResultEvidenceCapabilityState =
  Object.freeze({
    wireVersion: null,
    aggregateScalars: false,
    boundedRows: false,
  });

/**
 * Takes one coherent per-operation snapshot of the dynamic capture
 * configuration. Reads through the ordinary three-tier resolution
 * ({@link getActiveConfig}'s server → cache → default order, including the
 * lazy once-per-process cache promotion and the decision-trace
 * `config.tier` gate), then snapshots the master capture switch, fidelity,
 * result-evidence capability state, and identifier key of that single
 * resolved generation. The snapshot is synchronous, so no concurrent
 * config apply can interleave between the fields — a producer that reads
 * one view at operation admission observes one generation throughout the
 * operation, and a refresh or key rotation lands on the next operation's
 * view, never a view already taken.
 *
 * Fail-closed like its sibling admission read {@link isCaptureEnabled}: any
 * error during resolution (e.g. a failing `process.cwd()` inside the lazy
 * disk-cache tier) yields the everything-off view rather than throwing into
 * a producer's operation path.
 *
 * Internal — deliberately NOT exported from the package barrel; producers
 * inside the SDK are the only consumers.
 */
export function getOperationConfigView(): OperationConfigView {
  try {
    const config = resolveActiveConfig();
    const attrHmacKey = config.attrHmacKey ?? getStoredAttrHmacKey();
    const envelope = config.resultEvidenceCapabilities;
    const resultEvidence: ResultEvidenceCapabilityState =
      envelope !== undefined
        ? Object.freeze({
            wireVersion: envelope.wireVersion,
            aggregateScalars: envelope.aggregateScalars,
            boundedRows: envelope.boundedRows,
          })
        : UNAVAILABLE_RESULT_EVIDENCE;
    return Object.freeze({
      sideEffectEvidence: config.sideEffectEvidence === true,
      captureFidelity: config.captureFidelity ?? "strict",
      resultEvidence,
      readAttrHmacKey: () => attrHmacKey,
    });
  } catch {
    return Object.freeze({
      sideEffectEvidence: false,
      captureFidelity: "strict" as CaptureFidelity,
      resultEvidence: UNAVAILABLE_RESULT_EVIDENCE,
      readAttrHmacKey: () => undefined,
    });
  }
}

/**
 * The per-account HMAC secret used to pseudonymize `*Id` columns, or
 * `undefined` when none is provisioned. Internal — deliberately NOT exported
 * from the package barrel, so the secret stays off the public API surface;
 * only the passive value-capture adapter reads it.
 *
 * Read from the shared active-config record's closure holder, so it is
 * reachable across bundle copies — including a copy that runs the Prisma
 * projection without having applied the config itself (the Turbopack-dev bundle
 * split). The raw key is held in a closure, off the record's enumerable
 * surface, so it never lands in a serialized dump. See `active-config-store.ts`.
 */
export function getAttrHmacKey(): string | undefined {
  return getStoredAttrHmacKey();
}

/**
 * Whether side-effect / value capture is enabled by the active capture
 * config. Reads the active capture config on every call so config rotation
 * takes effect on the next emission. Fail-closed: any error (or absent
 * config) resolves to `false`. Internal — not exported from the package
 * barrel.
 */
export function isCaptureEnabled(): boolean {
  try {
    return resolveActiveConfig().sideEffectEvidence === true;
  } catch {
    return false;
  }
}

/**
 * Returns the `linkedAccountId` from the current in-memory init response,
 * or `undefined` if no init response is available or no account is linked.
 *
 * Used by the discovery endpoint to determine whether `claimed: true`
 * should be included in the response.
 */
export function getLinkedAccountId(): string | undefined {
  return getActiveConfigResponse()?.linkedAccountId;
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
  return getActiveConfigResponse()?.claimResult;
}

/**
 * Resets the in-memory config store. For testing only.
 */
export function _resetConfigForTesting(): void {
  _resetActiveConfigForTesting();
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
 * Writes through the shared store so every bundle instance sees the value.
 *
 * `origin` records the config's provenance for the decision-trace
 * `config.tier` gate; it defaults to `"server"` (a live response) and should
 * be passed as `"cache"` when applying a config loaded from the on-disk cache.
 */
export function _setCurrentConfig(
  config: SdkInitResponse,
  origin: ActiveConfigOrigin = "server",
): void {
  setActiveConfig(config, origin);
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
 * fails, rather than relying on the
 * runtime fire-and-forget call which can silently fail inside a
 * Next.js 16 process.
 *
 * Verification matches the application boundary's envelope tolerance: a
 * response whose only defect is an invalid result-evidence capability
 * envelope verifies as reachable (the runtime applies exactly that
 * response, with both capabilities unavailable), so the CLI never reports
 * a server as malformed that the running SDK accepts. A response invalid
 * anywhere else is still classified `malformed`.
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
    const body = await sendInitRequestBody(config, anonKey, sdkVersion);
    const response =
      parseInitResponseWithEnvelopeTolerance(body) ??
      SdkInitResponseSchema.parse(body);
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
