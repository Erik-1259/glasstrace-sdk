import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
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

const GLASSTRACE_DIR = ".glasstrace";
const CONFIG_FILE = "config";
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const INIT_TIMEOUT_MS = 10_000;

/** In-memory config from the latest successful init response. */
let currentConfig: SdkInitResponse | null = null;

/** Whether the disk cache has already been checked by getActiveConfig(). */
let configCacheChecked = false;

/** Whether the next init call should be skipped (rate-limit backoff). */
let rateLimitBackoff = false;

/**
 * Reads and validates a cached config file from `.glasstrace/config`.
 * Returns the parsed `SdkInitResponse` or `null` on any failure.
 */
export function loadCachedConfig(projectRoot?: string): SdkInitResponse | null {
  const root = projectRoot ?? process.cwd();
  const configPath = join(root, GLASSTRACE_DIR, CONFIG_FILE);

  try {
    // Use synchronous read for startup performance (this is called during init)
    const content = readFileSync(configPath, "utf-8");
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
      return result.data;
    }

    console.warn("[glasstrace] Cached config failed validation. Using defaults.");
    return null;
  } catch {
    return null;
  }
}

/**
 * Persists the init response to `.glasstrace/config`.
 * On failure, logs a warning and continues.
 */
export async function saveCachedConfig(
  response: SdkInitResponse,
  projectRoot?: string,
): Promise<void> {
  const root = projectRoot ?? process.cwd();
  const dirPath = join(root, GLASSTRACE_DIR);
  const configPath = join(dirPath, CONFIG_FILE);

  try {
    await mkdir(dirPath, { recursive: true, mode: 0o700 });
    await chmod(dirPath, 0o700);
    const cached = {
      response,
      cachedAt: Date.now(),
    };
    await writeFile(configPath, JSON.stringify(cached), { encoding: "utf-8", mode: 0o600 });
    await chmod(configPath, 0o600);
  } catch (err) {
    console.warn(
      `[glasstrace] Failed to cache config to ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Sends a POST request to `/v1/sdk/init`.
 * Validates the response against `SdkInitResponseSchema`.
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
    apiKey: effectiveKey,
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${effectiveKey}`,
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    // Consume the response body to release the connection back to the pool.
    // Without this, the underlying TCP socket stays allocated until GC, which
    // causes connection pool exhaustion under sustained error conditions.
    // Wrapped in try-catch so a stream error doesn't mask the HTTP status error.
    try { await response.text(); } catch { /* body drain is best-effort */ }
    const error = new Error(`Init request failed with status ${response.status}`);
    (error as unknown as Record<string, unknown>).status = response.status;
    throw error;
  }

  const body = await response.json();
  return SdkInitResponseSchema.parse(body);
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
 */
export async function writeClaimedKey(
  newApiKey: string,
  projectRoot?: string,
): Promise<void> {
  const root = projectRoot ?? process.cwd();
  const envLocalPath = join(root, ".env.local");

  // Step 1: Try writing to .env.local
  let envLocalWritten = false;
  try {
    let content: string;
    try {
      content = await readFile(envLocalPath, "utf-8");
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

    await writeFile(envLocalPath, content, { encoding: "utf-8", mode: 0o600 });
    await chmod(envLocalPath, 0o600);
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
    const dirPath = join(root, GLASSTRACE_DIR);
    await mkdir(dirPath, { recursive: true, mode: 0o700 });
    await chmod(dirPath, 0o700);
    const claimedKeyPath = join(dirPath, "claimed-key");
    await writeFile(claimedKeyPath, newApiKey, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await chmod(claimedKeyPath, 0o600);
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

  // Step 3: All file writes failed — log a message WITHOUT the key
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
): Promise<InitClaimResult | null> {
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INIT_TIMEOUT_MS);

    try {
      // Delegate to sendInitRequest to avoid duplicating fetch logic
      const result = await sendInitRequest(
        config,
        anonKey,
        sdkVersion,
        undefined,
        undefined,
        undefined,
        controller.signal,
      );

      clearTimeout(timeoutId);

      // Update in-memory config
      currentConfig = result;

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
      clearTimeout(timeoutId);

      if (err instanceof DOMException && err.name === "AbortError") {
        console.warn("[glasstrace] ingestion_unreachable: Init request timed out.");
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
    // Outermost catch -- should never reach here, but safety net
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
 * Resets the in-memory config store. For testing only.
 */
export function _resetConfigForTesting(): void {
  currentConfig = null;
  configCacheChecked = false;
  rateLimitBackoff = false;
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
