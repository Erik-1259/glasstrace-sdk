/**
 * Minimal Node-native HTTPS transport used by the SDK init call.
 *
 * ## Why this exists
 *
 * Next.js 16 patches the global `fetch` to add caching, revalidation,
 * and request deduplication. When the SDK is bundled into a Next.js
 * process (instrumentation.ts path), outbound calls to
 * `api.glasstrace.dev` get intercepted by the patched fetch and can
 * silently hang — the fetch promise never resolves (DISC-493 Issue 3).
 *
 * A silent init hang is catastrophic: the SDK stays in "pending key"
 * state forever, enriched spans are buffered without ever being
 * exported, and anonymous keys are never registered server-side
 * (DISC-494).
 *
 * ## Why `node:https`
 *
 * `node:https` is a Node.js core module. It has zero bundle weight
 * (important because the SDK is tsup-inlined into every consumer's
 * bundle) and is always available on Node.js >= 20. Using it directly
 * bypasses the global `fetch` patching entirely — Next.js never sees
 * the request.
 *
 * Alternatives considered and rejected:
 *
 * - **`undici` as a runtime dep** — adds ~400KB inlined into every
 *   consumer bundle.
 * - **`fetch(..., { cache: "no-store", next: { revalidate: 0 } })`** —
 *   bandaid. Couples the SDK to Next.js's fetch-extension API and still
 *   relies on Next's patched fetch behaving correctly. Explicitly
 *   forbidden by the task brief for this reason.
 * - **Monkey-patch `globalThis.fetch`** — forbidden in the public SDK
 *   (`glasstrace-sdk/CLAUDE.md`). Bypassing the patched fetch by
 *   calling a different API is avoidance, not patching.
 *
 * ## Structure
 *
 * `httpsPostJson` is the only exported function. It:
 *   - Sends a POST to a URL with a JSON body
 *   - Applies a per-request timeout (default 10s)
 *   - Retries transport-level failures (DNS, TCP, TLS) with backoff
 *   - Never retries HTTP status errors — those are surfaced immediately
 *   - Distinguishes transport failure, server error, and body-parse error
 *     so callers can render actionable messages
 */
import {
  request as httpsRequest,
  type RequestOptions as HttpsRequestOptions,
} from "node:https";
import {
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import { URL } from "node:url";

/** Error thrown when the HTTP request never completed (DNS/TCP/TLS/timeout). */
export class HttpsTransportError extends Error {
  readonly kind = "transport" as const;
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "HttpsTransportError";
    this.cause = cause;
  }
}

/** Error thrown when the server returned a non-2xx HTTP status. */
export class HttpsStatusError extends Error {
  readonly kind = "status" as const;
  readonly status: number;
  /** Raw response body text (may be truncated by caller if large). */
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Server returned HTTP ${status}`);
    this.name = "HttpsStatusError";
    this.status = status;
    this.body = body;
  }
}

/** Error thrown when the response body was not parseable JSON. */
export class HttpsBodyParseError extends Error {
  readonly kind = "parse" as const;
  readonly status: number;
  readonly cause?: unknown;
  constructor(status: number, cause?: unknown) {
    super(`Server returned malformed response (HTTP ${status})`);
    this.name = "HttpsBodyParseError";
    this.status = status;
    this.cause = cause;
  }
}

/** Options controlling timeout and retry behavior. */
export interface HttpsPostJsonOptions {
  /** Parsed headers (including Content-Type, Authorization, etc). */
  headers: Record<string, string>;
  /** Per-attempt timeout, ms. Defaults to 10000. */
  timeoutMs?: number;
  /**
   * Total number of attempts INCLUDING the first. Defaults to 3
   * (initial + 2 retries). Only transport errors are retried.
   */
  maxAttempts?: number;
  /**
   * Backoff delays between retries, ms. The array length should be
   * `maxAttempts - 1`. Defaults to [500, 1500].
   */
  retryDelaysMs?: readonly number[];
  /**
   * Total deadline across all attempts, ms. Defaults to 20000.
   * If exceeded, no further retries are attempted and the last error
   * is surfaced. Guards against CLI hang on flaky networks.
   */
  totalDeadlineMs?: number;
  /**
   * Abort signal. When aborted, the in-flight request is terminated and
   * no further retries are attempted.
   */
  signal?: AbortSignal;
  /**
   * Scheduler injection point for tests. Defaults to `setTimeout`.
   * Using fake timers in tests requires the injected scheduler to honor
   * `vi.advanceTimersByTime()` — Node's real setTimeout is fine when no
   * fake timers are installed.
   */
  scheduler?: (fn: () => void, ms: number) => { unref?: () => void };
  /**
   * Alternate HTTPS request function. Injected by tests to simulate
   * Next.js-style fetch patching (assert call count stays zero) or to
   * mock transport behavior without opening real sockets.
   */
  requestImpl?: typeof httpsRequest;
  /**
   * Alternate HTTP request function, used when the URL is `http://`.
   * Splitting http/https lets tests use a local non-TLS mock server.
   */
  httpRequestImpl?: typeof httpRequest;
}

/** Shape of a successful response. */
export interface HttpsPostJsonResult {
  /** HTTP status code. Always in [200, 299] for success. */
  status: number;
  /** Parsed JSON body. May be `undefined` for 204 No Content. */
  body: unknown;
  /** Raw body text for diagnostics. */
  raw: string;
}

/** Delays so a failing test still completes before the suite's timeout. */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [500, 1500] as const;
const DEFAULT_TOTAL_DEADLINE_MS = 20_000;

/**
 * Sends a POST request with a JSON body using `node:https`. Bypasses
 * any `globalThis.fetch` patching (Next.js 16, MSW, etc).
 *
 * @throws {HttpsTransportError} DNS failure, TCP reset, TLS handshake
 * failure, request timeout, or abort.
 * @throws {HttpsStatusError} HTTP response with status >= 400.
 * @throws {HttpsBodyParseError} HTTP 2xx with non-JSON body (status not
 * equal to 204).
 */
export async function httpsPostJson(
  url: string,
  jsonBody: unknown,
  options: HttpsPostJsonOptions,
): Promise<HttpsPostJsonResult> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const isHttp = parsed.protocol === "http:";
  if (!isHttps && !isHttp) {
    throw new HttpsTransportError(
      `Unsupported protocol: ${parsed.protocol} (expected http: or https:)`,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const totalDeadlineMs = options.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS;
  const scheduler = options.scheduler ?? ((fn, ms) => setTimeout(fn, ms));
  const requestImpl = isHttps
    ? (options.requestImpl ?? httpsRequest)
    : (options.httpRequestImpl ?? httpRequest);

  // Serialize once so retries use the exact same bytes.
  let payload: string;
  try {
    payload = JSON.stringify(jsonBody);
  } catch (err) {
    throw new HttpsTransportError(
      `Failed to serialize request body: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  const payloadBuffer = Buffer.from(payload, "utf-8");

  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (options.signal?.aborted) {
      throw new HttpsTransportError("Request aborted");
    }
    // Respect the total deadline — don't start another attempt if we'd
    // blow past it even before issuing the request.
    const elapsed = Date.now() - startedAt;
    if (elapsed >= totalDeadlineMs) {
      break;
    }
    const remainingBudget = totalDeadlineMs - elapsed;
    const attemptTimeoutMs = Math.min(timeoutMs, remainingBudget);

    try {
      return await sendSingleRequest(
        parsed,
        payloadBuffer,
        options.headers,
        attemptTimeoutMs,
        options.signal,
        requestImpl,
      );
    } catch (err) {
      lastError = err;
      // Never retry status/parse errors — they're server responses, not
      // transient network failures.
      if (err instanceof HttpsStatusError || err instanceof HttpsBodyParseError) {
        throw err;
      }
      const isLast = attempt === maxAttempts - 1;
      if (isLast) break;

      const delayMs = retryDelaysMs[attempt] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 0;
      const elapsedBeforeSleep = Date.now() - startedAt;
      const remaining = totalDeadlineMs - elapsedBeforeSleep;
      if (remaining <= 0) break;
      const actualDelayMs = Math.min(delayMs, remaining);
      await sleep(actualDelayMs, scheduler, options.signal);
    }
  }

  if (lastError instanceof HttpsTransportError) throw lastError;
  throw new HttpsTransportError(
    lastError instanceof Error ? lastError.message : "Request failed",
    lastError,
  );
}

/**
 * Fires a single HTTPS request. Resolves with the parsed result on 2xx,
 * throws the appropriate typed error otherwise. Caller handles retries.
 */
function sendSingleRequest(
  url: URL,
  payload: Buffer,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  requestImpl: typeof httpsRequest,
): Promise<HttpsPostJsonResult> {
  return new Promise<HttpsPostJsonResult>((resolve, reject) => {
    // Merge caller headers with Content-Length so Node doesn't chunk
    // the body. Explicit content-length also prevents confusion from
    // servers that reject chunked POSTs.
    const finalHeaders: Record<string, string | number> = {
      ...headers,
      "Content-Length": payload.byteLength,
    };

    const reqOptions: HttpsRequestOptions = {
      method: "POST",
      hostname: url.hostname,
      port: url.port === "" ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      headers: finalHeaders,
      // Explicit timeout at the socket level. Still complemented by a
      // manual timer below because `timeout` only fires when the socket
      // is idle — it does not cover "TLS handshake hangs forever".
      timeout: timeoutMs,
    };

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    const req = requestImpl(reqOptions, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf-8") : chunk);
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          settle(() => reject(new HttpsStatusError(status, raw)));
          return;
        }
        // HTTP 204: no body is expected; resolve with undefined.
        if (status === 204 || raw.length === 0) {
          settle(() => resolve({ status, body: undefined, raw }));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          settle(() => resolve({ status, body: parsed, raw }));
        } catch (err) {
          settle(() => reject(new HttpsBodyParseError(status, err)));
        }
      });
      res.on("error", (err) => {
        settle(() => reject(new HttpsTransportError(`Response stream error: ${err.message}`, err)));
      });
    });

    // A single manual timeout guards against handshake/DNS hangs that
    // the `timeout` option in `request()` does not cover. We destroy the
    // socket on timeout so the node:https layer doesn't keep it alive.
    const timer = setTimeout(() => {
      settle(() => {
        req.destroy(new Error("Request timed out"));
        reject(new HttpsTransportError(`Request timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    // Don't block process exit while the timer is running.
    if (typeof timer.unref === "function") timer.unref();

    req.on("error", (err) => {
      clearTimeout(timer);
      settle(() => reject(new HttpsTransportError(`fetch failed: ${err.message}`, err)));
    });

    req.on("timeout", () => {
      clearTimeout(timer);
      settle(() => {
        req.destroy(new Error("Request timed out"));
        reject(new HttpsTransportError(`Request timed out after ${timeoutMs}ms`));
      });
    });

    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer);
        req.destroy(new Error("Aborted"));
        settle(() => reject(new HttpsTransportError("Request aborted")));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        req.destroy(new Error("Aborted"));
        settle(() => reject(new HttpsTransportError("Request aborted")));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // `end` clears the pending timer only on success via the settle path.
    req.end(payload);
  });
}

/**
 * Delay helper that honors an AbortSignal. We cannot use `setTimeout`'s
 * built-in `signal` option because it is not available in older Node 20
 * patch releases (added in 20.6).
 */
function sleep(
  ms: number,
  scheduler: (fn: () => void, ms: number) => { unref?: () => void },
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = scheduler(() => {
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    const onAbort = (): void => {
      reject(new HttpsTransportError("Request aborted"));
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
