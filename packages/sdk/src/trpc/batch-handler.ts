/**
 * `wrapBatchedHttpHandler` — opt-in HTTP-handler wrapper that
 * inspects incoming tRPC batch URLs and sets a request-scoped
 * batch envelope so `tracedMiddleware` can label each member span
 * with `glasstrace.trpc.batch.member_index` /
 * `glasstrace.trpc.batch.member_procedures` (SDK-052 / Wave 16B,
 * advances DISC-1534 SDK-side slice).
 *
 * **Opt-in design (v1):** the wrapper is a separate exported helper
 * that apps wire into their tRPC handler explicitly. Apps NOT using
 * the wrapper (or apps NOT using `tracedMiddleware`) see no trace-
 * shape change. A future brief may add auto-detection.
 *
 * **Cross-version compatibility:** v10 and v11 both fire
 * `tracedMiddleware` per procedure during batch dispatch. The
 * envelope is propagated via `AsyncLocalStorage` rather than tRPC's
 * `createContext` shape (which differs between major versions).
 *
 * **Failure modes are non-throwing:** a malformed URL, unparseable
 * batch segment, or unsupported request shape causes the wrapper to
 * fall through to the underlying handler unchanged. The trace shape
 * remains identical to today's behavior (no per-member spans).
 */
import { sdkLog } from "../console-capture.js";
import {
  withBatchEnvelope,
  type BatchEnvelope,
  type BatchMember,
} from "./batch-context.js";

/**
 * Configuration for {@link wrapBatchedHttpHandler}.
 */
export interface WrapBatchedHttpHandlerOptions {
  /**
   * The HTTP path prefix where the tRPC handler is mounted. Defaults
   * to `/api/trpc/` (the most common Next.js tRPC mount path).
   *
   * Apps that mount tRPC at a different path (e.g. `/trpc/`,
   * `/api/v2/trpc/`) MUST pass their actual base path here — the
   * wrapper does NOT auto-detect to avoid both false matches
   * (unrelated routes containing `trpc`) and missed matches (custom
   * mounts). Per DISC-1215, the tRPC base path is configurable on
   * the user side; this option propagates that decision.
   *
   * The supplied value MUST end with `/` so it doesn't accidentally
   * match prefix substrings (e.g., `/api/trpc-internal/...` should
   * not match `/api/trpc/`).
   */
  basePath?: string;
}

/**
 * Whether the wrapper has logged a malformed-URL warning for the
 * current process. Rate-limits to one warning per session so a
 * misconfigured base path doesn't flood logs on a hot request path.
 */
let _malformedUrlWarned = false;

/**
 * Wrap a tRPC HTTP handler so batched requests get per-member span
 * attribution via `tracedMiddleware`.
 *
 * The wrapper inspects the incoming request's URL on each call. If
 * the URL matches the batch pattern at the configured base path,
 * the wrapper parses the comma-joined procedure list, builds a
 * {@link BatchEnvelope}, and runs the underlying handler inside
 * the envelope's `AsyncLocalStorage` scope. `tracedMiddleware`
 * (which the user's tRPC procedure chain must already include)
 * reads the envelope and adds the batch attributes to each member
 * span.
 *
 * Non-batched requests (no `batch=` query param, or single-procedure
 * URL without comma-list) pass through to the underlying handler
 * unchanged — the trace shape is identical to today's behavior.
 *
 * @example
 * ```ts
 * import { wrapBatchedHttpHandler } from "@glasstrace/sdk/trpc";
 * import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
 *
 * const handler = (req: Request) =>
 *   fetchRequestHandler({ endpoint: "/api/trpc", req, router });
 *
 * export const POST = wrapBatchedHttpHandler(handler);
 * export const GET = wrapBatchedHttpHandler(handler);
 * ```
 */
export function wrapBatchedHttpHandler<
  H extends (...args: never[]) => unknown,
>(handler: H, options?: WrapBatchedHttpHandlerOptions): H {
  const rawBasePath = options?.basePath ?? "/api/trpc/";
  // Normalize: ensure trailing slash so prefix matching is exact.
  const basePath = rawBasePath.endsWith("/") ? rawBasePath : `${rawBasePath}/`;

  const wrapped = ((...args: Parameters<H>): ReturnType<H> => {
    const url = extractRequestUrl(args[0]);
    if (url === undefined) {
      return handler(...args) as ReturnType<H>;
    }
    const envelope = parseBatchUrl(url, basePath);
    if (envelope === undefined) {
      return handler(...args) as ReturnType<H>;
    }
    return withBatchEnvelope(envelope, () =>
      handler(...args),
    ) as ReturnType<H>;
  }) as H;

  return wrapped;
}

/**
 * Extracts the request URL from various tRPC handler argument
 * shapes. Returns `undefined` for shapes the wrapper doesn't
 * recognize (in which case the wrapper falls through to a no-op
 * pass-through — never throws).
 *
 * Supported shapes:
 *   - Web `Request` (Next.js app-router, fetch adapter): `.url`
 *   - Next.js `NextRequest`: `.nextUrl.href` or `.url`
 *   - Node `IncomingMessage` (Express, raw http): `.url`
 *   - tRPC's own `{ req, res }` envelope: `req.url`
 */
function extractRequestUrl(arg: unknown): string | undefined {
  if (typeof arg !== "object" || arg === null) {
    return undefined;
  }
  // Web Request / Next.js NextRequest both have a `.url` string field.
  const directUrl = (arg as { url?: unknown }).url;
  if (typeof directUrl === "string") {
    return directUrl;
  }
  // Some tRPC adapters wrap the Web Request in `{ req, res }`.
  const reqWrapper = (arg as { req?: { url?: unknown } }).req;
  if (
    reqWrapper !== undefined &&
    reqWrapper !== null &&
    typeof reqWrapper === "object"
  ) {
    const wrappedUrl = reqWrapper.url;
    if (typeof wrappedUrl === "string") {
      return wrappedUrl;
    }
  }
  // NextRequest exposes `nextUrl.href` as a fallback.
  const nextUrl = (arg as { nextUrl?: { href?: unknown } }).nextUrl;
  if (
    nextUrl !== undefined &&
    nextUrl !== null &&
    typeof nextUrl === "object"
  ) {
    const href = nextUrl.href;
    if (typeof href === "string") {
      return href;
    }
  }
  return undefined;
}

/**
 * Parses a request URL into a `BatchEnvelope` if it's a tRPC batch
 * request at the configured base path. Returns `undefined` for
 * non-batch URLs, malformed URLs, or non-matching base paths.
 *
 * Detection rules:
 *   1. URL must match `<basePath><proc-list>?...` — base path is a
 *      prefix of the path (after URL parsing strips host/scheme).
 *   2. The URL must carry a `batch=` query parameter (any value;
 *      `batch=1` is the canonical form).
 *   3. The procedure list is the URL segment between `<basePath>`
 *      and the next `?` or `#`. It MAY contain a single name (a
 *      single-procedure batch is still a batch in tRPC's protocol
 *      semantics — `batch=1` with one input).
 */
function parseBatchUrl(
  url: string,
  basePath: string,
): BatchEnvelope | undefined {
  let pathname: string;
  let search: string;
  try {
    // Use a placeholder origin so relative URLs (path-only) parse
    // identically to absolute URLs. The placeholder is discarded —
    // we only consume `pathname` and `search`.
    const parsed = new URL(url, "http://glasstrace.invalid/");
    pathname = parsed.pathname;
    search = parsed.search;
  } catch {
    rateLimitWarn(`malformed URL: cannot parse "${url}"`);
    return undefined;
  }

  // Detect batch via the `batch=` query parameter. Use string
  // search (NOT URLSearchParams) because tRPC's wire format uses
  // `?batch=1` and we want presence detection, not a specific value.
  if (!/[?&]batch=/.test(search)) {
    return undefined;
  }

  // Match base path as a prefix.
  if (!pathname.startsWith(basePath)) {
    return undefined;
  }

  // Procedure-list segment is everything between basePath and the
  // end of pathname. (search/hash were already split off.)
  const procSegment = pathname.slice(basePath.length);
  if (procSegment.length === 0) {
    return undefined;
  }

  // Decode percent-escapes so procedure names with `.` survive (the
  // tRPC client URL-encodes `.` → `%2E` in some configurations);
  // post-decode, we split on `,` to recover the member list.
  let decoded: string;
  try {
    decoded = decodeURIComponent(procSegment);
  } catch {
    rateLimitWarn(`malformed batch URL: ${procSegment}`);
    return undefined;
  }

  const names = decoded.split(",").filter((s) => s.length > 0);
  if (names.length === 0) {
    return undefined;
  }

  const procedures: BatchMember[] = names.map((name, index) => ({
    name,
    index,
  }));

  return {
    procedures,
    nameCounters: new Map<string, number>(),
  };
}

/**
 * Emit a warning to stderr at most once per process. Rate-limited
 * to avoid log floods on a hot request path when a wrapper
 * misconfiguration affects every request.
 */
function rateLimitWarn(reason: string): void {
  if (_malformedUrlWarned) {
    return;
  }
  _malformedUrlWarned = true;
  sdkLog(
    "warn",
    `[glasstrace] wrapBatchedHttpHandler: ${reason}; falling back to pass-through. Subsequent malformed-URL warnings suppressed for this process.`,
  );
}

/**
 * Reset the rate-limit guard. Test-only export.
 */
export function _resetBatchHandlerForTesting(): void {
  _malformedUrlWarned = false;
}
