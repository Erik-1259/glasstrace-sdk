import type { AnonApiKey, SessionId } from "@glasstrace/protocol";

/**
 * Tracks whether the runtime-handler deprecation warning has already been
 * emitted for this process. The warning is noisy by design (we want users
 * to migrate) but should fire exactly once per process — repeated logs on
 * every request would drown out real warnings and spam CI output.
 */
let runtimeHandlerDeprecationWarned = false;

/**
 * @internal Reset the deprecation-warning flag. Test-only.
 */
export function _resetDiscoveryDeprecationWarningForTesting(): void {
  runtimeHandlerDeprecationWarned = false;
}

/**
 * Emits a one-time `console.warn` explaining that the runtime discovery
 * handler has been superseded by the static file written by `sdk init`.
 *
 * Scheduled for removal in v1.0.0 per the deprecation timeline documented
 * in the "SDK Discovery Endpoint / Static File" design doc. Kept out of
 * the module top level so bundlers can tree-shake the warning path when
 * the handler itself is not imported.
 *
 * The `[glasstrace]` prefix matches the SDK-internal log convention so
 * console capture (see `console-capture.ts`) skips the warning rather
 * than recording it as a user-facing span event.
 */
function warnRuntimeHandlerDeprecatedOnce(): void {
  if (runtimeHandlerDeprecationWarned) return;
  runtimeHandlerDeprecationWarned = true;
  console.warn(
    "[glasstrace] createDiscoveryHandler is deprecated. " +
      "Run `npx glasstrace init` to generate a static file at " +
      "public/.well-known/glasstrace.json (or static/.well-known/glasstrace.json " +
      "on SvelteKit). The runtime handler will be removed in v1.0.0.",
  );
}

/**
 * Checks whether the given Origin header is allowed for CORS access.
 *
 * Allowed origins:
 * - `chrome-extension://*` — any Chrome extension
 * - `moz-extension://*` — any Firefox extension
 * - `safari-web-extension://*` — any Safari extension
 * - Absent origin (same-origin / non-browser request)
 *
 * Replaced wildcard `*` to prevent arbitrary websites from
 * reading the anonymous API key from localhost.
 */
function isAllowedOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  if (origin.startsWith("chrome-extension://")) return true;
  if (origin.startsWith("moz-extension://")) return true;
  if (origin.startsWith("safari-web-extension://")) return true;
  return false;
}

/**
 * Builds CORS headers for a given request origin.
 * Returns headers with `Access-Control-Allow-Origin` set to the origin
 * if allowed, otherwise omits that header entirely.
 */
function buildCorsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Vary: "Origin",
  };

  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

/**
 * Claim state returned by the `getClaimState` callback.
 *
 * - `claimed` — `true` when the anonymous key has been linked to an account.
 * - `accountHint` — optional masked identifier (e.g. `"er***@example.com"`)
 *   for the browser extension to display to the user.
 */
export interface ClaimState {
  claimed: boolean;
  accountHint?: string;
}

/**
 * Creates a request handler for the `/__glasstrace/config` discovery endpoint.
 *
 * The returned handler checks if the request URL path is `/__glasstrace/config`.
 * If not, returns `null` (pass-through). If it matches, returns a `DiscoveryResponse`
 * with the anonymous key and current session ID.
 *
 * When `getClaimState` returns a non-null value with `claimed: true`, the
 * response includes `claimed` and (optionally) `accountHint` so the browser
 * extension can prompt the user to sign in.
 *
 * The triple guard (anonymous + dev + active) is enforced by the caller,
 * not by this module. If the handler is registered, it serves.
 */
export function createDiscoveryHandler(
  getAnonKey: () => Promise<AnonApiKey | null>,
  getSessionId: () => SessionId,
  getClaimState?: () => ClaimState | null,
): (request: Request) => Promise<Response | null> {
  return async (request: Request): Promise<Response | null> => {
    // Check path match
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }

    if (url.pathname !== "/__glasstrace/config") {
      return null;
    }

    // Fire the deprecation notice only when the handler actually serves a
    // Glasstrace-discovery request — non-matching paths pass through, so
    // warning there would spam users who never invoked the handler.
    warnRuntimeHandlerDeprecatedOnce();

    // Restrict CORS to known extension origins instead of wildcard
    const origin = request.headers.get("Origin");
    const corsHeaders = buildCorsHeaders(origin);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Only allow GET requests
    if (request.method !== "GET") {
      return new Response(
        JSON.stringify({ error: "method_not_allowed" }),
        {
          status: 405,
          headers: corsHeaders,
        },
      );
    }

    try {
      // Get the anonymous key
      const anonKey = await getAnonKey();

      if (anonKey === null) {
        return new Response(
          JSON.stringify({ error: "not_ready" }),
          {
            status: 503,
            headers: corsHeaders,
          },
        );
      }

      // Get the current session ID
      const sessionId = getSessionId();

      // Build response body, conditionally including claim fields
      const responseBody: Record<string, unknown> = { key: anonKey, sessionId };
      const claimState = getClaimState?.();
      if (claimState?.claimed) {
        responseBody.claimed = true;
        if (claimState.accountHint) {
          responseBody.accountHint = claimState.accountHint;
        }
      }

      return new Response(
        JSON.stringify(responseBody),
        {
          status: 200,
          headers: corsHeaders,
        },
      );
    } catch {
      return new Response(
        JSON.stringify({ error: "internal_error" }),
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }
  };
}

// Exported for testing
export { isAllowedOrigin, buildCorsHeaders };
