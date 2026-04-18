import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  ClientRequest,
  IncomingMessage,
} from "node:http";
import { EventEmitter } from "node:events";

import {
  httpsPostJson,
  HttpsTransportError,
  HttpsStatusError,
  HttpsBodyParseError,
} from "../../../packages/sdk/src/https-transport.js";

/**
 * Minimal fake Node HTTPS request used by tests. Lets us drive status,
 * body, error, and timeout behavior without opening real sockets — and
 * without touching `globalThis.fetch` (which is the whole point of this
 * transport module).
 */
interface FakeResponse {
  statusCode?: number;
  chunks?: string[];
  streamError?: Error;
}

interface FakeRequestOptions {
  response?: FakeResponse;
  requestError?: Error;
  timeoutAfterMs?: number;
  delayMs?: number;
}

function createFakeRequestImpl(
  options: FakeRequestOptions,
): (
  opts: unknown,
  cb: (res: IncomingMessage) => void,
) => ClientRequest {
  return (_opts, cb) => {
    const req = new EventEmitter() as ClientRequest & EventEmitter;
    let ended = false;
    req.end = (() => {
      ended = true;
      // Defer the response so the returned object has time to attach
      // its error/timeout listeners — mirroring real node:https behavior.
      setTimeout(() => {
        if (!ended) return;
        if (options.requestError !== undefined) {
          req.emit("error", options.requestError);
          return;
        }
        if (options.timeoutAfterMs !== undefined) {
          setTimeout(() => {
            req.emit("timeout");
          }, options.timeoutAfterMs);
          return;
        }
        const response = options.response;
        if (response === undefined) return;
        const res = new EventEmitter() as IncomingMessage & EventEmitter;
        res.statusCode = response.statusCode ?? 200;
        cb(res);
        setTimeout(() => {
          if (response.streamError !== undefined) {
            res.emit("error", response.streamError);
            return;
          }
          for (const chunk of response.chunks ?? []) {
            res.emit("data", Buffer.from(chunk, "utf-8"));
          }
          res.emit("end");
        }, options.delayMs ?? 0);
      }, 0);
      return req;
    }) as unknown as ClientRequest["end"];
    req.destroy = (() => {
      ended = false;
    }) as unknown as ClientRequest["destroy"];
    return req;
  };
}

describe("httpsPostJson", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with parsed JSON on 200", async () => {
    const requestImpl = createFakeRequestImpl({
      response: {
        statusCode: 200,
        chunks: [JSON.stringify({ hello: "world" })],
      },
    });

    const result = await httpsPostJson(
      "https://example.test/v1/sdk/init",
      { key: "value" },
      {
        headers: { "Content-Type": "application/json" },
        requestImpl: requestImpl as never,
      },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ hello: "world" });
  });

  it("resolves with undefined body on HTTP 204 No Content", async () => {
    const requestImpl = createFakeRequestImpl({
      response: { statusCode: 204, chunks: [] },
    });

    const result = await httpsPostJson(
      "https://example.test/v1/sdk/init",
      {},
      {
        headers: {},
        requestImpl: requestImpl as never,
      },
    );

    expect(result.status).toBe(204);
    expect(result.body).toBeUndefined();
  });

  it("throws HttpsStatusError on 4xx", async () => {
    const requestImpl = createFakeRequestImpl({
      response: { statusCode: 401, chunks: ["Unauthorized"] },
    });

    await expect(
      httpsPostJson(
        "https://example.test/v1/sdk/init",
        {},
        {
          headers: {},
          requestImpl: requestImpl as never,
          maxAttempts: 1,
        },
      ),
    ).rejects.toBeInstanceOf(HttpsStatusError);
  });

  it("throws HttpsBodyParseError on 2xx with non-JSON body", async () => {
    const requestImpl = createFakeRequestImpl({
      response: { statusCode: 200, chunks: ["not-json{{{"] },
    });

    await expect(
      httpsPostJson(
        "https://example.test/v1/sdk/init",
        {},
        {
          headers: {},
          requestImpl: requestImpl as never,
        },
      ),
    ).rejects.toBeInstanceOf(HttpsBodyParseError);
  });

  it("does NOT route through globalThis.fetch (DISC-493 Issue 3)", async () => {
    // Simulate Next.js 16 patching globalThis.fetch.
    const patchedFetch = vi.fn();
    vi.stubGlobal("fetch", patchedFetch);

    const requestImpl = createFakeRequestImpl({
      response: {
        statusCode: 200,
        chunks: [JSON.stringify({ ok: true })],
      },
    });

    await httpsPostJson(
      "https://example.test/v1/sdk/init",
      {},
      {
        headers: {},
        requestImpl: requestImpl as never,
      },
    );

    // The whole point of this transport is to avoid the patched fetch.
    expect(patchedFetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("retries transport errors and succeeds on the third attempt", async () => {
    let attempts = 0;
    const requestImpl = ((_opts: unknown, cb: (res: IncomingMessage) => void) => {
      attempts += 1;
      const req = new EventEmitter() as ClientRequest & EventEmitter;
      req.end = (() => {
        setTimeout(() => {
          if (attempts < 3) {
            req.emit("error", new Error("ECONNREFUSED"));
            return;
          }
          const res = new EventEmitter() as IncomingMessage & EventEmitter;
          res.statusCode = 200;
          cb(res);
          setTimeout(() => {
            res.emit("data", Buffer.from(JSON.stringify({ success: true }), "utf-8"));
            res.emit("end");
          }, 0);
        }, 0);
        return req;
      }) as unknown as ClientRequest["end"];
      req.destroy = (() => {}) as unknown as ClientRequest["destroy"];
      return req;
    }) as unknown as typeof import("node:https").request;

    const result = await httpsPostJson(
      "https://example.test/v1/sdk/init",
      {},
      {
        headers: {},
        requestImpl,
        retryDelaysMs: [1, 1],
      },
    );

    expect(attempts).toBe(3);
    expect(result.body).toEqual({ success: true });
  });

  it("does NOT retry HttpsStatusError (HTTP 401)", async () => {
    let attempts = 0;
    const requestImpl = ((_opts: unknown, cb: (res: IncomingMessage) => void) => {
      attempts += 1;
      const req = new EventEmitter() as ClientRequest & EventEmitter;
      req.end = (() => {
        setTimeout(() => {
          const res = new EventEmitter() as IncomingMessage & EventEmitter;
          res.statusCode = 401;
          cb(res);
          setTimeout(() => {
            res.emit("data", Buffer.from("Unauthorized", "utf-8"));
            res.emit("end");
          }, 0);
        }, 0);
        return req;
      }) as unknown as ClientRequest["end"];
      req.destroy = (() => {}) as unknown as ClientRequest["destroy"];
      return req;
    }) as unknown as typeof import("node:https").request;

    await expect(
      httpsPostJson(
        "https://example.test/v1/sdk/init",
        {},
        {
          headers: {},
          requestImpl,
          retryDelaysMs: [1, 1],
        },
      ),
    ).rejects.toBeInstanceOf(HttpsStatusError);

    // HTTP status errors must be surfaced immediately — no retry.
    expect(attempts).toBe(1);
  });

  it("surfaces request error as HttpsTransportError", async () => {
    const requestImpl = createFakeRequestImpl({
      requestError: new Error("getaddrinfo ENOTFOUND example.test"),
    });

    await expect(
      httpsPostJson(
        "https://example.test/v1/sdk/init",
        {},
        {
          headers: {},
          requestImpl: requestImpl as never,
          maxAttempts: 1,
        },
      ),
    ).rejects.toBeInstanceOf(HttpsTransportError);
  });

  it("respects the per-attempt timeout", async () => {
    const requestImpl = createFakeRequestImpl({
      // Respond only after the timeout fires.
      response: { statusCode: 200, chunks: ['{"ok":true}'] },
      delayMs: 5_000,
    });

    const started = Date.now();
    await expect(
      httpsPostJson(
        "https://example.test/v1/sdk/init",
        {},
        {
          headers: {},
          requestImpl: requestImpl as never,
          timeoutMs: 50,
          maxAttempts: 1,
        },
      ),
    ).rejects.toBeInstanceOf(HttpsTransportError);
    // Must have completed in less than the full 5s delay.
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("honors an AbortSignal pre-abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const requestImpl = createFakeRequestImpl({
      response: { statusCode: 200, chunks: ['{}'] },
    });

    await expect(
      httpsPostJson(
        "https://example.test/v1/sdk/init",
        {},
        {
          headers: {},
          requestImpl: requestImpl as never,
          signal: controller.signal,
        },
      ),
    ).rejects.toBeInstanceOf(HttpsTransportError);
  });

  it("respects totalDeadlineMs and does not retry past the deadline", async () => {
    let attempts = 0;
    const requestImpl = ((_opts: unknown, cb: (res: IncomingMessage) => void) => {
      void cb;
      attempts += 1;
      const req = new EventEmitter() as ClientRequest & EventEmitter;
      req.end = (() => {
        setTimeout(() => {
          req.emit("error", new Error("ECONNREFUSED"));
        }, 0);
        return req;
      }) as unknown as ClientRequest["end"];
      req.destroy = (() => {}) as unknown as ClientRequest["destroy"];
      return req;
    }) as unknown as typeof import("node:https").request;

    const started = Date.now();
    await expect(
      httpsPostJson(
        "https://example.test/v1/sdk/init",
        {},
        {
          headers: {},
          requestImpl,
          retryDelaysMs: [100, 100],
          totalDeadlineMs: 50,
        },
      ),
    ).rejects.toBeInstanceOf(HttpsTransportError);

    // The first attempt fires, then the retry is skipped because the
    // deadline has elapsed. attempts should be 1 (not 3).
    expect(attempts).toBeLessThan(3);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("rejects unsupported URL protocols", async () => {
    await expect(
      httpsPostJson(
        "ftp://example.test/v1/sdk/init",
        {},
        { headers: {} },
      ),
    ).rejects.toBeInstanceOf(HttpsTransportError);
  });

  it("includes Content-Length in the outgoing request", async () => {
    let capturedHeaders: Record<string, unknown> | undefined;
    const requestImpl = ((opts: { headers?: Record<string, unknown> }, cb: (res: IncomingMessage) => void) => {
      capturedHeaders = opts.headers;
      const req = new EventEmitter() as ClientRequest & EventEmitter;
      req.end = (() => {
        setTimeout(() => {
          const res = new EventEmitter() as IncomingMessage & EventEmitter;
          res.statusCode = 200;
          cb(res);
          setTimeout(() => {
            res.emit("data", Buffer.from("{}", "utf-8"));
            res.emit("end");
          }, 0);
        }, 0);
        return req;
      }) as unknown as ClientRequest["end"];
      req.destroy = (() => {}) as unknown as ClientRequest["destroy"];
      return req;
    }) as unknown as typeof import("node:https").request;

    await httpsPostJson(
      "https://example.test/v1/sdk/init",
      { hello: "world" },
      {
        headers: { Authorization: "Bearer gt_dev_****" },
        requestImpl,
      },
    );

    expect(capturedHeaders?.["Content-Length"]).toBeDefined();
    expect(typeof capturedHeaders?.["Content-Length"]).toBe("number");
    expect(capturedHeaders?.Authorization).toBe("Bearer gt_dev_****");
  });
});
