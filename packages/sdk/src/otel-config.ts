import type { ResolvedConfig } from "./env-detection.js";
import type { SessionManager } from "./session.js";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import * as otelApi from "@opentelemetry/api";
import { GlasstraceExporter, API_KEY_PENDING } from "./enriching-exporter.js";
import { getActiveConfig } from "./init-client.js";
import { sdkLog } from "./console-capture.js";
import { setOtelState, OtelState, emitLifecycleEvent, registerShutdownHook, registerBeforeExitTrigger, pushDegradationSource } from "./lifecycle.js";
import {
  peekExportCircuitBreaker,
  _resetExportCircuitBreakerForTesting,
} from "./export-circuit-breaker.js";
import { hashApiKey } from "./api-key-hash.js";
import {
  emitNudgeMessage,
  emitGuidanceMessage,
  tryAutoAttachGlasstraceProcessor,
} from "./coexistence.js";
import { setCoexistenceState, _resetCoexistenceStateForTesting } from "./signal-handler.js";
import { isProxyTracerProvider, isProxyTracer } from "./proxy-detection.js";

/** Module-level resolved API key, updated when the anon key resolves. */
let resolvedApiKey: string = API_KEY_PENDING;

/** Module-level reference to the active exporter for key-resolution notification. */
let activeExporter: GlasstraceExporter | null = null;

/** Additional exporters that need key-resolution notification (from createGlasstraceSpanProcessor). */
const additionalExporters: GlasstraceExporter[] = [];

/** Injected processor in coexistence mode, tracked for flush on exit. */
let injectedProcessor: SpanProcessor | null = null;

/**
 * SHA-256-derived stable identifier of the most recently resolved
 * API key. Used to detect credential rotation (DISC-1568 / Wave 15C)
 * so the export-path circuit breaker can reset to CLOSED on rotation.
 */
let resolvedApiKeyHash: string = "";

/**
 * Sets the resolved API key for OTel export authentication.
 * Called once the anonymous key or dev key is available.
 *
 * On rotation (the new key's SHA-256 differs from the previously-
 * stored hash) this notifies the export-path circuit breaker so any
 * outage tied to the old credentials is cleared. The breaker is
 * peeked, not constructed — if no exporter has yet observed a batch
 * the breaker is absent and the rotation has nothing to clear.
 *
 * @param key - The resolved API key (anonymous or developer).
 */
export function setResolvedApiKey(key: string): void {
  const newHash = hashApiKey(key);
  // Skip rotation handling when this is the first key resolution
  // (there's nothing to "rotate from") OR when the key is unchanged.
  // The first-resolution check uses the stored hash being empty so
  // the same setResolvedApiKey() call does not erroneously trip a
  // rotation-reset on the very first key arrival from the registration
  // path.
  const isRotation = resolvedApiKeyHash !== "" && resolvedApiKeyHash !== newHash;
  resolvedApiKey = key;
  resolvedApiKeyHash = newHash;
  if (isRotation) {
    peekExportCircuitBreaker()?.resetForKeyRotation();
  }
}

/**
 * Returns the current resolved API key.
 * Returns the {@link API_KEY_PENDING} sentinel if the key has not yet resolved.
 */
export function getResolvedApiKey(): string {
  return resolvedApiKey;
}

/**
 * Notifies the active exporter that the API key has transitioned from
 * "pending" to a resolved value. This triggers flushing of any buffered spans.
 */
export function notifyApiKeyResolved(): void {
  activeExporter?.notifyKeyResolved();
  for (const exporter of additionalExporters) {
    exporter.notifyKeyResolved();
  }
}

/**
 * Register an additional exporter for key-resolution notification.
 * Used by createGlasstraceSpanProcessor() so its exporter gets notified
 * when the API key resolves (flushing buffered spans immediately rather
 * than waiting for the next BSP timer tick).
 */
export function registerExporterForKeyNotification(exporter: GlasstraceExporter): void {
  additionalExporters.push(exporter);
}

/**
 * Resets OTel configuration state to initial values. For testing only.
 */
export function resetOtelConfigForTesting(): void {
  resolvedApiKey = API_KEY_PENDING;
  resolvedApiKeyHash = "";
  activeExporter = null;
  injectedProcessor = null;
  additionalExporters.length = 0;
  // The export circuit breaker is conceptually part of the OTel
  // export pipeline owned by this module, so its singleton is reset
  // here too. Test files that reset the OTel config get a fresh
  // breaker without having to import the breaker reset directly.
  _resetExportCircuitBreakerForTesting();
  // Signal and beforeExit handler cleanup is handled by resetLifecycleForTesting()
  // via the shutdown coordinator.
  // Reset coexistence state here as well so that test suites that call
  // resetOtelConfigForTesting() without _resetRegistrationForTesting() do
  // not leak coexistenceState ("coexisting" / "sole-owner") between tests.
  _resetCoexistenceStateForTesting();
}

/**
 * Dynamically imports an optional peer dependency at runtime.
 *
 * Uses `Function()` constructor to build the `import()` expression so that
 * bundlers (webpack, esbuild, turbopack) do not attempt to resolve the module
 * at compile time. This is intentional -- the SDK's peer dependencies are
 * optional, and static analysis would cause missing-module build errors for
 * users who have not installed them.
 *
 * **CSP note:** The `Function()` constructor is semantically equivalent to
 * `eval()` and will trigger Content Security Policy violations in environments
 * that disallow `unsafe-eval`. If your CSP blocks this, install the OTel peer
 * dependencies explicitly so they resolve via normal `import` statements, or
 * use the `@vercel/otel` path which does not rely on `tryImport` for its own
 * module.
 *
 * @param moduleId - The npm package name to import (e.g. "@vercel/otel").
 * @returns The module namespace object, or `null` if the module is not installed.
 */
async function tryImport(moduleId: string): Promise<Record<string, unknown> | null> {
  try {
    return await (Function("id", "return import(id)")(moduleId) as Promise<Record<string, unknown>>);
  } catch {
    return null;
  }
}

/**
 * Emits a verbose-only diagnostic when `@prisma/instrumentation` could not be
 * registered, so developers can see why Prisma query spans are missing instead
 * of getting a silent skip (DISC-1308).
 *
 * Default-quiet by design: the SDK cannot know whether the consuming app uses
 * Prisma, so an unconditional warning would be noise for the majority of apps
 * that do not. It fires only when the caller opted into `verbose` mode — the
 * same gate the OTel diagnostic logger below uses.
 *
 * @param verbose - Whether verbose diagnostics are enabled (`config.verbose`).
 * @param detail - Why registration was skipped (e.g. "could not be loaded").
 */
function warnPrismaInstrumentationUnavailable(verbose: boolean, detail: string): void {
  if (!verbose) return;
  sdkLog(
    "warn",
    `[glasstrace] @prisma/instrumentation ${detail}; Prisma query spans will ` +
      `not be captured. If you use Prisma and expect database spans, add ` +
      `@prisma/instrumentation as a direct dependency (some package managers, ` +
      `e.g. pnpm, do not expose transitive copies).`,
  );
}

/**
 * Configures OpenTelemetry with the GlasstraceExporter.
 *
 * Detection flow (per sdk-otel-coexistence.md v8+):
 *   1. Yield one tick (let synchronous Sentry.init() complete)
 *   2. Probe for existing provider
 *   3. If provider exists → shared coexistence path via
 *      {@link tryAutoAttachGlasstraceProcessor} (resolves DISC-493 Issues 2
 *      and 4 — Next.js 16 production pre-registration and Sentry hoisting)
 *   4. If no provider → registration path (Vercel or bare)
 */
export async function configureOtel(
  config: ResolvedConfig,
  sessionManager: SessionManager,
): Promise<void> {
  setOtelState(OtelState.CONFIGURING);

  // Step 1: Yield one tick to let synchronous Sentry.init() (or other tools)
  // complete before probing for an existing provider (DISC-1202).
  await new Promise<void>((resolve) => {
    if (typeof setImmediate === "function") {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });

  // Step 2: Probe for an existing OTel provider BEFORE the Vercel/bare split.
  // This unified detection ensures coexistence works regardless of whether
  // @vercel/otel is installed (sdk-otel-coexistence.md Section 2.4).
  //
  // DISC-1556: classification is structural rather than constructor-name
  // based. Next.js 16's production bundler renames `@opentelemetry/api`'s
  // `ProxyTracerProvider` / `ProxyTracer` to short minified identifiers
  // (`eN`/`ek`/etc.), which previously caused the SDK's own bundled proxy
  // to be misidentified as an external provider — see
  // `/tmp/recon-option-A-DISC-1556.md` and {@link isProxyTracerProvider}.
  //
  // OR-ordering edge case: if a third party extends a real provider (e.g.
  // `BasicTracerProvider`) and stamps the four `getDelegate*` method
  // names onto the subclass, `isProxyTracerProvider` returns `true`, but
  // the probe tracer (returned by the subclass's real `getTracer()`) is
  // a real `Tracer`, not a `ProxyTracer` — `isProxyTracer` returns
  // `false`. The OR short-circuit then sets
  // `anotherProviderRegistered = true`, which is the correct behavior
  // for a real provider with a custom shape.
  const existingProvider = otelApi.trace.getTracerProvider();
  const probeTracer = existingProvider.getTracer("glasstrace-probe");
  const anotherProviderRegistered =
    !isProxyTracerProvider(existingProvider) ||
    !isProxyTracer(probeTracer, existingProvider);

  // Step 3: If another provider exists → shared coexistence path.
  // This is the DISC-493 Issues 2 and 4 fix: instead of silently giving up
  // when a Next.js 16 production build or a Sentry import has already
  // registered a provider, auto-attach our span processor onto it.
  if (anotherProviderRegistered) {
    // Inform the signal handler that it should NOT re-raise — the existing
    // provider owns signal-based shutdown (DISC-1265).
    setCoexistenceState("coexisting");
    await runCoexistencePath(existingProvider, config);
    return;
  }

  // Step 4: No existing provider → registration path.
  // Inform the signal handler that Glasstrace owns the provider and should
  // re-raise after draining its hooks (DISC-1265).
  setCoexistenceState("sole-owner");
  await runRegistrationPath(config, sessionManager);
}

/**
 * Shared coexistence path for DISC-493 Issues 2 and 4.
 *
 * Used whenever `configureOtel()` detects a pre-registered OTel provider.
 * Delegates processor construction to {@link tryAutoAttachGlasstraceProcessor}
 * which reuses the `createGlasstraceSpanProcessor()` public primitive, so
 * the auto-attach path and the manual integration path stay in lockstep.
 *
 * Idempotence: if a Glasstrace-branded processor is already attached (from
 * a prior `registerGlasstrace()` call or a manual `createGlasstraceSpanProcessor()`
 * wiring), the auto-attach path returns `"already_present"` and no second
 * processor is created.
 */
async function runCoexistencePath(
  existingProvider: ReturnType<typeof otelApi.trace.getTracerProvider>,
  config: ResolvedConfig,
): Promise<void> {
  // Attempt to auto-attach via the shared primitive.
  //
  // tryAutoAttachGlasstraceProcessor() performs its own "already present"
  // check against the branded Symbol BEFORE constructing an exporter, so
  // idempotent registration does not create a wasted exporter instance.
  // It also reuses createGlasstraceSpanProcessor() for construction, so
  // the processor wiring (branded exporter, key-notification registration,
  // BSP flush interval) matches the documented manual path exactly.
  //
  // Pass through the subset of resolved config that `GlasstraceOptions`
  // accepts. `environment` is not in `GlasstraceOptions` (it's derived
  // from env vars inside `resolveConfig`), so the primitive picks it up
  // from the same environment variables `configureOtel()` sees.
  const result = tryAutoAttachGlasstraceProcessor(existingProvider, {
    endpoint: config.endpoint,
    verbose: config.verbose,
  });

  if (result === "already_present") {
    if (config.verbose) {
      sdkLog("info", "[glasstrace] Existing provider detected — Glasstrace processor already present.");
    }
    setOtelState(OtelState.PROCESSOR_PRESENT);
    emitLifecycleEvent("otel:configured", { state: OtelState.PROCESSOR_PRESENT, scenario: "B-clean" });
    return;
  }

  if (result !== null) {
    // Success: processor was attached. Retain a reference for the
    // coexistence flush hook (Section 7.2) so beforeExit drains buffered
    // spans even if the existing provider's shutdown does not propagate.
    injectedProcessor = result.processor;

    if (config.verbose) {
      sdkLog(
        "info",
        "[glasstrace] Existing provider detected — auto-attached Glasstrace span processor.",
      );
    }

    // Register coexistence flush hook via the lifecycle coordinator, and
    // wire the beforeExit trigger so the coordinator runs on event loop drain.
    // The existing provider handles signal-based shutdown (its MultiSpanProcessor
    // propagates shutdown() to our injected processor). The beforeExit trigger
    // covers the edge case where the process exits without signals. Both
    // triggers (signals and beforeExit) call executeShutdown() which is
    // idempotent — if one already ran, the other is a no-op.
    registerShutdownHook({
      name: "coexistence-flush",
      priority: 5,
      fn: async () => {
        if (injectedProcessor) {
          await injectedProcessor.forceFlush();
        }
      },
    });
    registerBeforeExitTrigger();

    const scenario = result.method === "v1_public" ? "D1" : "B-auto";
    setOtelState(OtelState.AUTO_ATTACHED);
    emitLifecycleEvent("otel:configured", { state: OtelState.AUTO_ATTACHED, scenario });
    emitLifecycleEvent("otel:injection_succeeded", { method: result.method });
    emitNudgeMessage();
    return;
  }

  // Injection failed (Scenario C/F) — emit guidance.
  if (config.verbose) {
    sdkLog("info", "[glasstrace] Existing provider detected — could not auto-attach.");
  }
  emitGuidanceMessage();
  setOtelState(OtelState.COEXISTENCE_FAILED);
  emitLifecycleEvent("otel:configured", { state: OtelState.COEXISTENCE_FAILED, scenario: "C/F" });
  emitLifecycleEvent("otel:injection_failed", { reason: "provider internals inaccessible" });
  // DISC-1556 Option C: emit a structured fail-loud diagnostic that the
  // runtime-state CLI bridge can persist. Distinct from
  // `otel:injection_failed` above, which carries a free-form reason for
  // logging only.
  //
  // PII-safety: only `delegate.constructor.name` is read. `delegate.url`,
  // `delegate._exporter.endpoint`, `delegate._headers`, and any other
  // field that could carry user-app data are deliberately untouched —
  // see `RuntimeStateLastError` in `runtime-state.ts` for the contract.
  emitLifecycleEvent("otel:failed", {
    category: "auto-attach-returned-null",
    message:
      "tryAutoAttachGlasstraceProcessor returned null — the existing OTel " +
      "TracerProvider exposed no injection point. Spans are not reaching " +
      "the Glasstrace exporter. Apply the manual createGlasstraceSpanProcessor() " +
      "workaround documented in the SDK README.",
    timestamp: new Date().toISOString(),
    providerClass: readProviderClass(existingProvider),
  });
  // Cross-layer effect: register a degradation source so the
  // centralised `recomputeCoreFromDegradationSources()` machinery is
  // the single source of truth for ACTIVE_DEGRADED. The push is
  // idempotent and self-guards: registry-driven recompute only acts
  // when core is `ACTIVE` (per DISC-1247, `KEY_PENDING` →
  // `ACTIVE_DEGRADED` is not a valid transition; the registry will
  // catch up at the moment core reaches `ACTIVE` via the catch-up
  // hook in `setCoreState`).
  //
  // Migrated from the prior `setCoreState(ACTIVE_DEGRADED)` direct
  // write per Copilot review of PR #260 (2026-05-08): a future
  // `clearDegradationSource` from another subsystem (e.g., the export
  // circuit) would otherwise have clobbered this auto-attach-failure
  // degradation back to ACTIVE because the registry didn't know about
  // it. Now both subsystems share the same registry semantics.
  pushDegradationSource("otel-coexistence-failed");
}

/**
 * Reads the constructor name of an existing TracerProvider's concrete
 * delegate for inclusion in the structured fail-loud diagnostic. Strict
 * PII-safety contract: this function MUST NOT read fields that could
 * carry user-app data (e.g. `delegate.url`, `delegate._exporter.endpoint`,
 * `delegate._headers`). Only the constructor name is captured.
 *
 * Returns `undefined` if the provider exposes no readable constructor
 * (defensive — a provider that throws on property access must not crash
 * the failure path).
 */
function readProviderClass(
  tracerProvider: ReturnType<typeof otelApi.trace.getTracerProvider>,
): string | undefined {
  try {
    // Unwrap ProxyTracerProvider to reach the concrete delegate, the same
    // shape `tryAutoAttachGlasstraceProcessor` introspects.
    const proxy = tracerProvider as unknown as { getDelegate?: () => unknown };
    const delegate = typeof proxy.getDelegate === "function"
      ? proxy.getDelegate()
      : tracerProvider;
    const name = (delegate as { constructor?: { name?: unknown } } | null)
      ?.constructor?.name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registration path when no existing OTel provider is detected.
 *
 * Tries `@vercel/otel` first (Scenario E). Falls back to constructing a
 * bare `BasicTracerProvider` (Scenario A). In both sub-scenarios,
 * Glasstrace owns the provider and installs its own shutdown hooks.
 */
async function runRegistrationPath(
  config: ResolvedConfig,
  sessionManager: SessionManager,
): Promise<void> {
  // Build OTLP exporter configuration
  const exporterUrl = `${config.endpoint}/v1/traces`;

  // OTLP exporter factory — always available since OTel is bundled.
  const createOtlpExporter = (url: string, headers: Record<string, string>) =>
    new OTLPTraceExporter({ url, headers });

  // Create the GlasstraceExporter that enriches + buffers + delegates
  const glasstraceExporter = new GlasstraceExporter({
    getApiKey: getResolvedApiKey,
    sessionManager,
    getConfig: () => getActiveConfig(),
    environment: config.environment,
    endpointUrl: exporterUrl,
    createDelegate: createOtlpExporter,
    verbose: config.verbose,
  });
  activeExporter = glasstraceExporter;

  // Try @vercel/otel first (Scenario E)
  const vercelOtel = await tryImport("@vercel/otel");
  if (vercelOtel && typeof vercelOtel.registerOTel === "function") {
    const otelConfig: Record<string, unknown> = {
      serviceName: "glasstrace-sdk",
      traceExporter: glasstraceExporter,
    };

    // Try @prisma/instrumentation
    const prismaModule = await tryImport("@prisma/instrumentation");
    if (prismaModule) {
      const PrismaInstrumentation = prismaModule.PrismaInstrumentation as
        (new () => unknown) | undefined;
      if (PrismaInstrumentation) {
        otelConfig.instrumentations = [new PrismaInstrumentation()];
      } else {
        warnPrismaInstrumentationUnavailable(
          config.verbose,
          "was loaded but did not export PrismaInstrumentation",
        );
      }
    } else {
      warnPrismaInstrumentationUnavailable(config.verbose, "could not be loaded");
    }

    (vercelOtel.registerOTel as (opts: Record<string, unknown>) => void)(otelConfig);

    // Register a shutdown hook so buffered spans are flushed on SIGTERM.
    // @vercel/otel does not install its own signal or beforeExit handlers
    // (verified empirically in DISC-1250 / vercel-shutdown.test.ts): it
    // constructs an internal Sdk instance and discards the reference, making
    // provider.shutdown() unreachable via any ambient mechanism. Without this
    // hook, spans buffered in the BatchSpanProcessor are lost when the Vercel
    // runtime delivers SIGTERM to the function worker (DISC-1263).
    //
    // Signal handlers are registered earlier in registerGlasstrace() via
    // registerSignalHandlers() (DISC-1249). This hook plugs into the existing
    // coordinator; registerBeforeExitTrigger() covers the event-loop-drain path.
    // Capture the concrete provider now (registration time) rather than at hook
    // execution time. If something replaced the global provider between now and
    // shutdown, we still flush the correct one — matching the pattern Scenario A
    // uses when capturing `provider` in a lexical closure.
    // @vercel/otel wraps its provider in a ProxyTracerProvider; unwrap once
    // to reach the concrete BasicTracerProvider that exposes shutdown().
    const vercelProxy = otelApi.trace.getTracerProvider() as unknown as {
      getDelegate?: () => { shutdown?: () => Promise<void> };
    };
    const vercelConcreteProvider = typeof vercelProxy.getDelegate === "function"
      ? vercelProxy.getDelegate()
      : (vercelProxy as { shutdown?: () => Promise<void> });
    registerShutdownHook({
      name: "vercel-otel-shutdown",
      priority: 0,
      fn: async () => {
        try {
          await vercelConcreteProvider.shutdown?.();
        } catch {
          // best-effort: provider may already be shut down or not support shutdown
        }
      },
    });
    registerBeforeExitTrigger();

    setOtelState(OtelState.OWNS_PROVIDER);
    emitLifecycleEvent("otel:configured", { state: OtelState.OWNS_PROVIDER, scenario: "E" });
    return;
  }

  // Bare OTel SDK fallback (Scenario A)

  // Enable OTel diagnostic logging in verbose mode so OTLP exporter
  // errors (auth failures, network issues) are surfaced to the developer.
  // Routes through sdkLog to avoid console-capture recording OTel internals.
  if (config.verbose) {
    otelApi.diag.setLogger(
      {
        verbose: (msg) => sdkLog("info", `[otel] ${msg}`),
        debug: (msg) => sdkLog("info", `[otel] ${msg}`),
        info: (msg) => sdkLog("info", `[otel] ${msg}`),
        warn: (msg) => sdkLog("warn", `[otel] ${msg}`),
        error: (msg) => sdkLog("error", `[otel] ${msg}`),
      },
      otelApi.DiagLogLevel.WARN,
    );
  }

  const processor = new BatchSpanProcessor(glasstraceExporter, {
    scheduledDelayMillis: 1000,
  });
  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
  });

  // Context manager is registered synchronously in registerGlasstrace()
  // before configureOtel() is called (DISC-1183). By this point, it's
  // already active and propagating trace context across async boundaries.

  otelApi.trace.setGlobalTracerProvider(provider);

  // Register OTel shutdown via lifecycle coordinator.
  // Signal handlers are installed upfront by registerGlasstrace() so they
  // exist during this async setup window (DISC-1249). beforeExit is still
  // wired here because Scenario A owns the provider and the coexistence
  // path registers its own beforeExit trigger independently.
  registerShutdownHook({
    name: "otel-provider-shutdown",
    priority: 0,
    fn: async () => {
      await provider.shutdown();
    },
  });
  registerBeforeExitTrigger();

  // Register Prisma instrumentation on the bare path (DISC-1223).
  // The Vercel path handles this via registerOTel({ instrumentations: [...] }).
  // The coexistence path gets Prisma from the existing provider (e.g., Sentry).
  // Only the bare path was missing it.
  const prismaModule = await tryImport("@prisma/instrumentation");
  if (prismaModule) {
    const PrismaInstrumentation = prismaModule.PrismaInstrumentation as
      (new () => unknown & { setTracerProvider: (p: unknown) => void; enable: () => void }) | undefined;
    if (PrismaInstrumentation) {
      try {
        const inst = new PrismaInstrumentation();
        inst.setTracerProvider(provider);
        inst.enable();
      } catch (err) {
        // Prisma instrumentation is optional — failure is not fatal. Surface
        // it in verbose mode so a silent skip is debuggable (DISC-1308).
        if (config.verbose) {
          sdkLog(
            "warn",
            `[glasstrace] @prisma/instrumentation failed to initialize: ${
              err instanceof Error ? err.message : String(err)
            }. Prisma query spans will not be captured.`,
          );
        }
      }
    } else {
      warnPrismaInstrumentationUnavailable(
        config.verbose,
        "was loaded but did not export PrismaInstrumentation",
      );
    }
  } else {
    warnPrismaInstrumentationUnavailable(config.verbose, "could not be loaded");
  }

  setOtelState(OtelState.OWNS_PROVIDER);
  emitLifecycleEvent("otel:configured", { state: OtelState.OWNS_PROVIDER, scenario: "A" });
}
