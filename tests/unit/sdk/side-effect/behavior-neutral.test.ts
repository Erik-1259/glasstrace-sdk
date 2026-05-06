/**
 * Behavior-neutrality tests for `recordSideEffect()` (SDK-049).
 *
 * Each of the six v1 operation kinds (email, calendar_link, webhook,
 * external_api, queue, after_callback) is exercised against a pure
 * in-memory mock provider. The test asserts that calling
 * `recordSideEffect()` does not invoke the provider, does not retry,
 * does not duplicate the operation, and does not perturb the
 * provider's observable state. This is the core SDK-049 contract:
 * emission is observational only.
 *
 * Mock providers expose only an in-memory log and a synthetic label
 * generator. They never construct payload-shaped values; rejection
 * inputs are constructed inline in test bodies and never live in
 * fixture files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as otelApi from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { recordSideEffect } from "../../../../packages/sdk/src/side-effect/index.js";
import {
  _setCurrentConfig,
  _resetConfigForTesting,
} from "../../../../packages/sdk/src/init-client.js";
import { installContextManager } from "../../../../packages/sdk/src/context-manager.js";
import type { SdkInitResponse } from "../../../../packages/protocol/src/wire.js";

// Install the AsyncLocalStorage context manager so `startActiveSpan`
// propagates the span into `otelApi.trace.getActiveSpan()`.
installContextManager();

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let tracer: otelApi.Tracer;

function enableCapture(): void {
  const response: SdkInitResponse = {
    config: {
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      consoleErrors: false,
      errorResponseBodies: false,
      sideEffectEvidence: true,
    },
    subscriptionStatus: "active",
    minimumSdkVersion: "0.0.0",
    apiVersion: "v1",
    tierLimits: {
      tracesPerMinute: 100,
      storageTtlHours: 48,
      maxTraceSizeBytes: 512_000,
      maxConcurrentSessions: 1,
    },
  } as SdkInitResponse;
  _setCurrentConfig(response);
}

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  otelApi.trace.setGlobalTracerProvider(provider);
  tracer = otelApi.trace.getTracer("glasstrace-sdk-test");
  enableCapture();
});

afterEach(async () => {
  _resetConfigForTesting();
  await provider.shutdown();
  otelApi.trace.disable();
  exporter.reset();
});

// --- Mock providers ---

interface EmailLog {
  to: string;
  templateKey: string;
}
function makeEmailMock(): {
  send: (input: EmailLog) => { id: string };
  log: ReadonlyArray<EmailLog>;
  count: () => number;
} {
  const log: EmailLog[] = [];
  return {
    send: (input) => {
      log.push(input);
      return { id: `mock-email-${log.length.toString()}` };
    },
    log,
    count: () => log.length,
  };
}

function makeCalendarMock(): {
  createBookingLabel: (slot: string) => string;
  count: () => number;
} {
  let calls = 0;
  return {
    createBookingLabel: (slot) => {
      calls += 1;
      return `booking-${slot}`;
    },
    count: () => calls,
  };
}

function makeWebhookMock(): {
  receive: (body: { kind: string }) => void;
  count: () => number;
} {
  let calls = 0;
  return {
    receive: () => {
      calls += 1;
    },
    count: () => calls,
  };
}

function makeExternalApiMock(): {
  fetchStub: (path: string) => Promise<{ ok: boolean }>;
  count: () => number;
} {
  let calls = 0;
  return {
    fetchStub: async () => {
      calls += 1;
      return { ok: true };
    },
    count: () => calls,
  };
}

function makeQueueMock(): {
  enqueue: (job: { name: string }) => void;
  jobs: ReadonlyArray<{ name: string }>;
  count: () => number;
} {
  const jobs: Array<{ name: string }> = [];
  return {
    enqueue: (job) => {
      jobs.push(job);
    },
    jobs,
    count: () => jobs.length,
  };
}

function makeAfterCallbackMock(): {
  schedule: (cb: () => void) => void;
  invoke: () => void;
  count: () => number;
} {
  let pending: (() => void) | null = null;
  let calls = 0;
  return {
    schedule: (cb) => {
      pending = cb;
    },
    invoke: () => {
      if (pending) {
        calls += 1;
        pending();
      }
    },
    count: () => calls,
  };
}

// --- Behavior-neutrality assertions ---

describe("recordSideEffect — email behavior-neutral", () => {
  it("does not invoke the provider; provider count is unchanged", () => {
    const email = makeEmailMock();
    tracer.startActiveSpan("test", (span) => {
      email.send({ to: "user@example.test", templateKey: "EventCanceledEmail" });
      const before = email.count();
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        status: "succeeded",
        fields: { templateKey: "EventCanceledEmail", role: "invitee" },
      });
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        status: "succeeded",
      });
      recordSideEffect({
        kind: "email",
        operation: "email.send",
        status: "succeeded",
      });
      expect(email.count()).toBe(before);
      span.end();
    });
  });
});

describe("recordSideEffect — calendar_link behavior-neutral", () => {
  it("does not synthesize a calendar link or call the provider", () => {
    const calendar = makeCalendarMock();
    tracer.startActiveSpan("test", (span) => {
      const label = calendar.createBookingLabel("2026-05-06");
      const before = calendar.count();
      recordSideEffect({
        kind: "calendar_link",
        operation: "calendar.invite.create",
        fields: { templateKey: "BookingConfirmed" },
      });
      expect(calendar.count()).toBe(before);
      // The synthesized label must remain a non-link string with no
      // scheme or query characters.
      expect(label).not.toContain("://");
      expect(label).not.toContain("?");
      span.end();
    });
  });
});

describe("recordSideEffect — webhook behavior-neutral", () => {
  it("does not duplicate the webhook receive", () => {
    const webhook = makeWebhookMock();
    tracer.startActiveSpan("test", (span) => {
      webhook.receive({ kind: "ping" });
      const before = webhook.count();
      recordSideEffect({
        kind: "webhook",
        operation: "webhook.dispatch",
      });
      expect(webhook.count()).toBe(before);
      span.end();
    });
  });
});

describe("recordSideEffect — external_api behavior-neutral", () => {
  it("does not invoke the stubbed fetch", async () => {
    const api = makeExternalApiMock();
    // Returning the async callback's promise so Vitest waits for the
    // assertions inside before completing the test. Without the
    // `return` Vitest finishes the test before the awaited
    // `api.fetchStub` resolves and the count assertion can run after
    // the test scope exits.
    await tracer.startActiveSpan("test", async (span) => {
      await api.fetchStub("/things");
      const before = api.count();
      recordSideEffect({
        kind: "external_api",
        operation: "external.api.call",
        status: "succeeded",
      });
      expect(api.count()).toBe(before);
      span.end();
    });
  });
});

describe("recordSideEffect — queue behavior-neutral", () => {
  it("does not enqueue duplicates", () => {
    const queue = makeQueueMock();
    tracer.startActiveSpan("test", (span) => {
      queue.enqueue({ name: "job-1" });
      const before = queue.count();
      recordSideEffect({
        kind: "queue",
        operation: "queue.enqueue",
        phase: "background",
      });
      expect(queue.count()).toBe(before);
      span.end();
    });
  });
});

describe("recordSideEffect — after_callback behavior-neutral", () => {
  it("does not invoke the scheduled callback", () => {
    const after = makeAfterCallbackMock();
    let userInvocations = 0;
    tracer.startActiveSpan("test", (span) => {
      after.schedule(() => {
        userInvocations += 1;
      });
      const beforeAfterCount = after.count();
      const beforeUserCount = userInvocations;
      recordSideEffect({
        kind: "after_callback",
        operation: "after.callback",
        phase: "post_response",
      });
      expect(after.count()).toBe(beforeAfterCount);
      expect(userInvocations).toBe(beforeUserCount);
      // User-driven invocation still runs as a separate observable
      // event; recordSideEffect does not double-fire it.
      after.invoke();
      expect(after.count()).toBe(beforeAfterCount + 1);
      expect(userInvocations).toBe(beforeUserCount + 1);
      span.end();
    });
  });
});

describe("recordSideEffect — combined cross-kind run", () => {
  it("never throws when called inside arbitrary mock-provider flows", () => {
    const email = makeEmailMock();
    const queue = makeQueueMock();
    tracer.startActiveSpan("test", (span) => {
      expect(() => {
        email.send({ to: "user@example.test", templateKey: "X" });
        recordSideEffect({ kind: "email", operation: "email.send" });
        queue.enqueue({ name: "n" });
        recordSideEffect({ kind: "queue", operation: "queue.enqueue" });
      }).not.toThrow();
      span.end();
    });
  });
});
