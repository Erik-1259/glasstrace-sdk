import type { AnonApiKey, SessionId } from "@glasstrace/protocol";

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
 * Creates a request handler for the `/__glasstrace/config` discovery endpoint.
 *
 * The returned handler checks if the request URL path is `/__glasstrace/config`.
 * If not, returns `null` (pass-through). If it matches, returns a `DiscoveryResponse`
 * with the anonymous key and current session ID.
 *
 * The triple guard (anonymous + dev + active) is enforced by the caller,
 * not by this module. If the handler is registered, it serves.
 */
export function createDiscoveryHandler(
  getAnonKey: () => Promise<AnonApiKey | null>,
  getSessionId: () => SessionId,
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

      return new Response(
        JSON.stringify({ key: anonKey, sessionId }),
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
