import { describe, it, expect } from "vitest";
import { DiscoveryResponseSchema } from "@glasstrace/protocol";
import type { AnonApiKey, SessionId } from "@glasstrace/protocol";
import { createDiscoveryHandler, isAllowedOrigin, buildCorsHeaders } from "../../../packages/sdk/src/discovery-endpoint.js";
import type { ClaimState } from "../../../packages/sdk/src/discovery-endpoint.js";

const MOCK_ANON_KEY = ("gt_anon_" + "a".repeat(48)) as AnonApiKey;
const MOCK_SESSION_ID = "abcdef0123456789" as SessionId;

function makeHandler(opts?: {
  anonKey?: AnonApiKey | null;
  sessionId?: SessionId;
  getAnonKeyThrows?: boolean;
  claimState?: ClaimState | null;
}) {
  const getAnonKey = opts?.getAnonKeyThrows
    ? () => Promise.reject(new Error("filesystem error"))
    : () => Promise.resolve(opts?.anonKey !== undefined ? opts.anonKey : MOCK_ANON_KEY);
  const getSessionId = () => opts?.sessionId ?? MOCK_SESSION_ID;
  const getClaimState = opts?.claimState !== undefined
    ? () => opts.claimState ?? null
    : undefined;
  return createDiscoveryHandler(getAnonKey, getSessionId, getClaimState);
}

function makeRequest(
  urlPath: string,
  method = "GET",
  origin?: string,
): Request {
  const headers: Record<string, string> = {};
  if (origin) {
    headers["Origin"] = origin;
  }
  return new Request(`http://localhost:3000${urlPath}`, { method, headers });
}

const CHROME_ORIGIN = "chrome-extension://abcdef1234567890";
const MOZ_ORIGIN = "moz-extension://abcdef1234567890";
const SAFARI_ORIGIN = "safari-web-extension://abcdef1234567890";

describe("Discovery Endpoint (/__glasstrace/config)", () => {
  describe("Checkpoint 1: GET /__glasstrace/config returns valid DiscoveryResponse", () => {
    it("returns 200 with key and sessionId (same-origin, no Origin header)", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response).not.toBeNull();
      const res = response!;
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.key).toBe(MOCK_ANON_KEY);
      expect(body.sessionId).toBe(MOCK_SESSION_ID);
    });

    it("returns 200 with CORS header for chrome extension origin", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config", "GET", CHROME_ORIGIN));

      expect(response).not.toBeNull();
      const res = response!;
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(CHROME_ORIGIN);
    });
  });

  describe("Checkpoint 2: Non-matching path returns null (passthrough)", () => {
    it("returns null for /api/users", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/api/users"));
      expect(response).toBeNull();
    });

    it("returns null for /", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/"));
      expect(response).toBeNull();
    });

    it("returns null for /__glasstrace/other", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/other"));
      expect(response).toBeNull();
    });
  });

  describe("Checkpoint 3: Non-GET method returns 405", () => {
    it("returns 405 for POST", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config", "POST"));

      expect(response).not.toBeNull();
      expect(response!.status).toBe(405);

      const body = await response!.json();
      expect(body.error).toBe("method_not_allowed");
    });

    it("returns 405 for DELETE", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config", "DELETE"));

      expect(response).not.toBeNull();
      expect(response!.status).toBe(405);
    });

    it("handles OPTIONS preflight for CORS with allowed origin", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config", "OPTIONS", CHROME_ORIGIN));

      expect(response).not.toBeNull();
      expect(response!.status).toBe(204);
      expect(response!.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
      expect(response!.headers.get("Access-Control-Allow-Origin")).toBe(CHROME_ORIGIN);
    });
  });

  describe("Checkpoint 4: Anon key not ready returns 503", () => {
    it("returns 503 when getAnonKey returns null", async () => {
      const handler = makeHandler({ anonKey: null });
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response).not.toBeNull();
      expect(response!.status).toBe(503);

      const body = await response!.json();
      expect(body.error).toBe("not_ready");
    });
  });

  describe("CORS headers — origin-based", () => {
    it("sets Access-Control-Allow-Origin to the chrome extension origin", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config", "GET", CHROME_ORIGIN));

      expect(response!.headers.get("Access-Control-Allow-Origin")).toBe(CHROME_ORIGIN);
    });

    it("sets Access-Control-Allow-Origin to the firefox extension origin", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config", "GET", MOZ_ORIGIN));

      expect(response!.headers.get("Access-Control-Allow-Origin")).toBe(MOZ_ORIGIN);
    });

    it("sets Access-Control-Allow-Origin to the safari extension origin", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config", "GET", SAFARI_ORIGIN));

      expect(response!.headers.get("Access-Control-Allow-Origin")).toBe(SAFARI_ORIGIN);
    });

    it("omits Access-Control-Allow-Origin for unrecognized origins", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config", "GET", "https://evil.com"));

      expect(response!.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("omits Access-Control-Allow-Origin when no Origin header (same-origin)", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response!.headers.get("Access-Control-Allow-Origin")).toBeNull();
    });

    it("includes Content-Type: application/json", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response!.headers.get("Content-Type")).toBe("application/json");
    });

    it("includes Vary: Origin for caching correctness", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response!.headers.get("Vary")).toBe("Origin");
    });

    it("includes CORS origin on 405 responses from extension", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config", "PUT", CHROME_ORIGIN));

      expect(response!.headers.get("Access-Control-Allow-Origin")).toBe(CHROME_ORIGIN);
    });

    it("includes CORS origin on 503 responses from extension", async () => {
      const handler = makeHandler({ anonKey: null });
      const response = await handler(makeRequest("/__glasstrace/config", "GET", MOZ_ORIGIN));

      expect(response!.headers.get("Access-Control-Allow-Origin")).toBe(MOZ_ORIGIN);
    });
  });

  describe("Checkpoint 6: Response validates against DiscoveryResponseSchema", () => {
    it("response body passes DiscoveryResponseSchema validation", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config"));

      const body = await response!.json();
      const result = DiscoveryResponseSchema.safeParse(body);
      expect(result.success).toBe(true);
    });
  });

  describe("Error case: Handler throws returns 500", () => {
    it("returns 500 with internal_error when getAnonKey throws an Error", async () => {
      const handler = makeHandler({ getAnonKeyThrows: true });
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response).not.toBeNull();
      expect(response!.status).toBe(500);

      const body = await response!.json();
      expect(body.error).toBe("internal_error");
    });

    it("returns 500 with internal_error when getAnonKey rejects with non-Error", async () => {
      const getAnonKey = () => Promise.reject("string rejection");
      const getSessionId = () => MOCK_SESSION_ID;
      const handler = createDiscoveryHandler(getAnonKey, getSessionId);
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response).not.toBeNull();
      expect(response!.status).toBe(500);

      const body = await response!.json();
      expect(body.error).toBe("internal_error");
    });
  });

  describe("isAllowedOrigin", () => {
    it("allows null origin (same-origin)", () => {
      expect(isAllowedOrigin(null)).toBe(true);
    });

    it("allows chrome-extension:// origins", () => {
      expect(isAllowedOrigin("chrome-extension://abcdef")).toBe(true);
    });

    it("allows moz-extension:// origins", () => {
      expect(isAllowedOrigin("moz-extension://abcdef")).toBe(true);
    });

    it("allows safari-web-extension:// origins", () => {
      expect(isAllowedOrigin("safari-web-extension://abcdef")).toBe(true);
    });

    it("rejects https:// origins", () => {
      expect(isAllowedOrigin("https://evil.com")).toBe(false);
    });

    it("rejects http:// origins", () => {
      expect(isAllowedOrigin("http://localhost:3000")).toBe(false);
    });
  });

  describe("buildCorsHeaders", () => {
    it("includes Allow-Origin for allowed extension origin", () => {
      const headers = buildCorsHeaders("chrome-extension://abc");
      expect(headers["Access-Control-Allow-Origin"]).toBe("chrome-extension://abc");
    });

    it("omits Allow-Origin for disallowed origin", () => {
      const headers = buildCorsHeaders("https://evil.com");
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("omits Allow-Origin for null origin", () => {
      const headers = buildCorsHeaders(null);
      expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    });

    it("always includes Vary: Origin", () => {
      expect(buildCorsHeaders(null)["Vary"]).toBe("Origin");
      expect(buildCorsHeaders("chrome-extension://abc")["Vary"]).toBe("Origin");
    });
  });

  describe("Claim state in discovery response", () => {
    it("includes claimed: true when getClaimState returns claimed", async () => {
      const handler = makeHandler({ claimState: { claimed: true } });
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response).not.toBeNull();
      const body = await response!.json();
      expect(body.claimed).toBe(true);
      expect(body.accountHint).toBeUndefined();
    });

    it("includes claimed and accountHint when both are provided", async () => {
      const handler = makeHandler({
        claimState: { claimed: true, accountHint: "er***@example.com" },
      });
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response).not.toBeNull();
      const body = await response!.json();
      expect(body.claimed).toBe(true);
      expect(body.accountHint).toBe("er***@example.com");
    });

    it("omits claimed when getClaimState returns null", async () => {
      const handler = makeHandler({ claimState: null });
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response).not.toBeNull();
      const body = await response!.json();
      expect(body.claimed).toBeUndefined();
      expect(body.accountHint).toBeUndefined();
    });

    it("omits claimed when getClaimState is not provided", async () => {
      const handler = makeHandler();
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response).not.toBeNull();
      const body = await response!.json();
      expect(body.claimed).toBeUndefined();
    });

    it("omits claimed when getClaimState returns claimed: false", async () => {
      const handler = makeHandler({ claimState: { claimed: false } });
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response).not.toBeNull();
      const body = await response!.json();
      expect(body.claimed).toBeUndefined();
    });

    it("omits accountHint when claimed is true but accountHint is empty string", async () => {
      const handler = makeHandler({
        claimState: { claimed: true, accountHint: "" },
      });
      const response = await handler(makeRequest("/__glasstrace/config"));

      expect(response).not.toBeNull();
      const body = await response!.json();
      expect(body.claimed).toBe(true);
      expect(body.accountHint).toBeUndefined();
    });

    it("response with claim state validates against DiscoveryResponseSchema", async () => {
      const handler = makeHandler({
        claimState: { claimed: true, accountHint: "er***@example.com" },
      });
      const response = await handler(makeRequest("/__glasstrace/config"));

      const body = await response!.json();
      const result = DiscoveryResponseSchema.safeParse(body);
      expect(result.success).toBe(true);
    });

    it("response without claim state validates against DiscoveryResponseSchema", async () => {
      const handler = makeHandler({ claimState: null });
      const response = await handler(makeRequest("/__glasstrace/config"));

      const body = await response!.json();
      const result = DiscoveryResponseSchema.safeParse(body);
      expect(result.success).toBe(true);
    });
  });
});
