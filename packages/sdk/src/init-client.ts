import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
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
    await mkdir(dirPath, { recursive: true });
    const cached = {
      response,
      cachedAt: Date.now(),
    };
    await writeFile(configPath, JSON.stringify(cached), "utf-8");
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
  // Determine the API key for auth
  const effectiveKey = config.apiKey ?? anonKey;
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
    const error = new Error(`Init request failed with status ${response.status}`);
    (error as unknown as Record<string, unknown>).status = response.status;
    throw error;
  }

  const body = await response.json();
  return SdkInitResponseSchema.parse(body);
}

/**
 * Orchestrates the full init flow: send request, update config, cache result.
 * This function MUST NOT throw.
 */
export async function performInit(
  config: ResolvedConfig,
  anonKey: AnonApiKey | null,
  sdkVersion: string,
): Promise<void> {
  // Skip if in rate-limit backoff
  if (rateLimitBackoff) {
    rateLimitBackoff = false; // Reset for next call
    return;
  }

  try {
    const effectiveKey = config.apiKey ?? anonKey;
    if (!effectiveKey) {
      console.warn("[glasstrace] No API key available for init request.");
      return;
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
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof DOMException && err.name === "AbortError") {
        console.warn("[glasstrace] ingestion_unreachable: Init request timed out.");
        return;
      }

      // Check for HTTP status errors attached by sendInitRequest
      const status = (err as Record<string, unknown>).status;
      if (status === 401) {
        console.warn(
          "[glasstrace] ingestion_auth_failed: Check your GLASSTRACE_API_KEY.",
        );
        return;
      }

      if (status === 429) {
        console.warn("[glasstrace] ingestion_rate_limited: Backing off.");
        rateLimitBackoff = true;
        return;
      }

      if (typeof status === "number" && status >= 400) {
        console.warn(
          `[glasstrace] Init request failed with status ${status}. Using cached config.`,
        );
        return;
      }

      // Schema validation failure from sendInitRequest.parse
      if (err instanceof Error && err.name === "ZodError") {
        console.warn(
          "[glasstrace] Init response failed validation (schema version mismatch?). Using cached config.",
        );
        return;
      }

      // Network error or other fetch failure
      console.warn(
        `[glasstrace] ingestion_unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } catch (err) {
    // Outermost catch -- should never reach here, but safety net
    console.warn(
      `[glasstrace] Unexpected init error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Returns the current capture config from the three-tier fallback chain:
 * 1. In-memory config from latest init response
 * 2. File cache
 * 3. DEFAULT_CAPTURE_CONFIG
 */
export function getActiveConfig(): CaptureConfig {
  // Tier 1: in-memory
  if (currentConfig) {
    return currentConfig.config;
  }

  // Tier 2: file cache
  const cached = loadCachedConfig();
  if (cached) {
    return cached.config;
  }

  // Tier 3: defaults
  return { ...DEFAULT_CAPTURE_CONFIG };
}

/**
 * Resets the in-memory config store. For testing only.
 */
export function _resetConfigForTesting(): void {
  currentConfig = null;
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
