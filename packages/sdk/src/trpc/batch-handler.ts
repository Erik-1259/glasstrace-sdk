/**
 * `wrapBatchedHttpHandler` — opt-in HTTP-handler wrapper that
 * inspects incoming tRPC batch URLs and sets a request-scoped
 * batch envelope so `tracedMiddleware` can label each member span
 * with `glasstrace.trpc.batch.member_index` /
 * `glasstrace.trpc.batch.member_procedures`.
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
  buildEnvelope,
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
   * mounts). The tRPC base path is configurable on
   * the user side; this option propagates that decision.
   *
   * Callers MAY supply the path with or without a trailing `/` —
   * the wrapper normalizes by appending `/` when missing. The
   * normalized form (with trailing `/`) is what's used for prefix
   * matching, so it can't accidentally match prefix substrings
   * (e.g., `/api/trpc-internal/...` does not match `/api/trpc/`).
   * Apps SHOULD pass the trailing slash explicitly; the runtime
   * normalization is a safety net, not a documented affordance.
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
 * Non-batched requests (no `batch=` query param OR a URL whose
 * pathname doesn't match the configured `basePath`) pass through
 * to the underlying handler unchanged — the trace shape is
 * identical to today's behavior. **Single-procedure URLs with
 * `batch=1` ARE treated as batches** (a one-member batch is still
 * a batch in tRPC's protocol semantics; the wrapper builds a
 * single-element envelope and `tracedMiddleware` labels the one
 * member span with `member_index: 0`).
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
 * Express-mounting awareness: when an Express app mounts the
 * tRPC handler with `app.use('/api/trpc', ...)`, the framework
 * rewrites `req.url` to strip the mount prefix — so a request to
 * `/api/trpc/polls.get?batch=1` arrives at the handler with
 * `req.url === '/polls.get?batch=1'` and `req.originalUrl ===
 * '/api/trpc/polls.get?batch=1'`. The wrapper prefers
 * `originalUrl` (and `baseUrl + url` as a secondary fallback) so
 * the basePath match against `/api/trpc/` succeeds for Express
 * users without forcing them to mount-aware-configure the wrapper.
 *
 * Supported shapes (checked in this preference order):
 *   - Express `Request`: `.originalUrl` (mount-aware)
 *   - Express `Request`: `.baseUrl + .url` reconstruction
 *   - Web `Request` / Next.js `NextRequest`: `.url`
 *   - Next.js `NextRequest`: `.nextUrl.href` (fallback)
 *   - tRPC's own `{ req, res }` envelope: `req.originalUrl` /
 *     `req.url` via the same precedence
 */
function extractRequestUrl(arg: unknown): string | undefined {
  if (typeof arg !== "object" || arg === null) {
    return undefined;
  }
  // Try the request object directly first.
  const direct = readUrlFromRequest(arg);
  if (direct !== undefined) {
    return direct;
  }
  // Some tRPC adapters wrap the request in `{ req, res }`.
  const reqWrapper = (arg as { req?: unknown }).req;
  if (
    reqWrapper !== undefined &&
    reqWrapper !== null &&
    typeof reqWrapper === "object"
  ) {
    const wrapped = readUrlFromRequest(reqWrapper);
    if (wrapped !== undefined) {
      return wrapped;
    }
  }
  // NextRequest exposes `nextUrl.href` as a final fallback.
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
 * Reads the most-correct URL from a request-shaped object,
 * preferring `originalUrl` (Express mount-aware) over `url`. Falls
 * back to `baseUrl + url` reconstruction when only those are
 * available.
 */
function readUrlFromRequest(req: object): string | undefined {
  // Express request: originalUrl is the un-rewritten request path
  // including any mount prefix that was stripped from `url`.
  const originalUrl = (req as { originalUrl?: unknown }).originalUrl;
  if (typeof originalUrl === "string" && originalUrl.length > 0) {
    return originalUrl;
  }
  // Reconstruct from baseUrl + url for Express-mounted handlers
  // that don't expose originalUrl (rare, but defensively handled).
  const baseUrl = (req as { baseUrl?: unknown }).baseUrl;
  const url = (req as { url?: unknown }).url;
  if (
    typeof baseUrl === "string" &&
    baseUrl.length > 0 &&
    typeof url === "string"
  ) {
    return baseUrl + url;
  }
  // Web Request / Next.js NextRequest / un-mounted Node http:
  // plain `.url` carries the full request path.
  if (typeof url === "string") {
    return url;
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

  return buildEnvelope(procedures);
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
