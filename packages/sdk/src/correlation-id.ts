import { trace } from "@opentelemetry/api";
import { GLASSTRACE_ATTRIBUTE_NAMES } from "@glasstrace/protocol";

const ATTR = GLASSTRACE_ATTRIBUTE_NAMES;
const HEADER_NAME = "x-gt-cid";

/**
 * Hard cap on the correlation ID length we accept from the wire. Our
 * own extension emits ULIDs (26 characters); 128 is a generous ceiling
 * that still prevents a hostile client from ballooning span payloads.
 */
const MAX_CID_LENGTH = 128;

/**
 * Minimal Fetch-API `Headers`-like interface supporting case-insensitive
 * single-value lookup. Matches `Headers` from `undici` / the Web Fetch API.
 */
interface FetchHeadersLike {
  get(name: string): string | null;
}

/**
 * Minimal Node `IncomingMessage.headers`-like shape: a dictionary mapping
 * (typically lower-cased) header names to a value, a list of values, or
 * `undefined`.
 */
type NodeHeadersLike = Record<
  string,
  string | string[] | undefined
>;

/**
 * Accepted request shape for {@link captureCorrelationId}. Intentionally
 * loose so callers can pass either a Fetch `Request` (or `NextRequest`)
 * or a Node `IncomingMessage` without adapting the type.
 */
export interface CorrelationIdRequest {
  headers: FetchHeadersLike | NodeHeadersLike | undefined;
}

/**
 * Captures the Glasstrace correlation ID header (`x-gt-cid`) from an
 * incoming request and materializes it as the
 * `glasstrace.correlation.id` attribute on the currently active OTel span
 * (DISC-1253).
 *
 * The SDK does not own any HTTP instrumentation, so it cannot read this
 * header itself. Users opt in by calling this helper from a hook that
 * runs inside the request's OTel context — typically a Next.js
 * `middleware.ts` or a custom server request handler.
 *
 * The function is intentionally forgiving:
 * - No active span → no-op.
 * - Missing / empty header → no-op.
 * - Array header values (Node IncomingMessage) → the first non-empty
 *   value is used; subsequent values are ignored because a correlation
 *   ID is a single logical value.
 * - Malformed or unexpected `headers` shapes → caught and ignored; the
 *   helper never throws.
 *
 * @example
 * ```ts
 * // Next.js middleware.ts
 * import { captureCorrelationId } from "@glasstrace/sdk";
 *
 * export function middleware(req: Request) {
 *   captureCorrelationId(req);
 *   return NextResponse.next();
 * }
 * ```
 */
export function captureCorrelationId(req: CorrelationIdRequest | null | undefined): void {
  try {
    if (!req || !req.headers) {
      return;
    }

    const value = readHeader(req.headers);
    if (!value) {
      return;
    }

    const span = trace.getActiveSpan();
    if (!span) {
      return;
    }

    span.setAttribute(ATTR.CORRELATION_ID, value);
  } catch {
    // Never throw from a request hook — correlation is a best-effort
    // enrichment and must not break the user's request pipeline.
  }
}

/**
 * Reads the `x-gt-cid` header from either a Fetch-API `Headers` object
 * or a Node-style dictionary. Returns a trimmed single value, or
 * `undefined` if the header is missing or empty.
 */
function readHeader(
  headers: FetchHeadersLike | NodeHeadersLike,
): string | undefined {
  // Fetch-API Headers: duck-type on `.get(name)` being a function.
  const asFetch = headers as FetchHeadersLike;
  if (typeof asFetch.get === "function") {
    const raw = asFetch.get(HEADER_NAME);
    return normalize(raw);
  }

  // Node IncomingMessage headers: case-insensitive dictionary lookup.
  // Node normalizes to lower-case but some frameworks preserve case, so
  // scan keys defensively.
  const dict = headers as NodeHeadersLike;
  const direct = dict[HEADER_NAME];
  if (direct !== undefined) {
    return firstValue(direct);
  }

  for (const key of Object.keys(dict)) {
    if (key.toLowerCase() === HEADER_NAME) {
      return firstValue(dict[key]);
    }
  }

  return undefined;
}

/**
 * Picks the first value from a possibly-array header and trims it.
 * Correlation IDs are logically single-valued; when duplicated we keep
 * the first occurrence and drop the rest.
 */
function firstValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const trimmed = normalize(entry);
      if (trimmed) return trimmed;
    }
    return undefined;
  }
  return normalize(value);
}

function normalize(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_CID_LENGTH) return undefined;
  return trimmed;
}
