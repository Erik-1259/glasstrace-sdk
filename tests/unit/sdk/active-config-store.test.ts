/**
 * Regression tests for the cross-bundle-instance active-config store.
 *
 * The defect this guards against: under Turbopack `next dev` HMR and the
 * edge-vs-node bundle split, the bundler can evaluate more than one copy
 * of the config module in a single process. When the active capture-config
 * lived in plain module-level state, the copy that the background init
 * wrote (the served `sideEffectEvidence: true`) was not necessarily the
 * copy the in-request emitter read, so the gate fell through to the
 * fail-closed default and categorical evidence dropped silently.
 *
 * Moving the state onto a `globalThis` singleton keyed on
 * `Symbol.for("glasstrace.active-config")` makes every bundle instance
 * read and write the same record. These tests simulate two module
 * instances with `vi.resetModules()` + dynamic `import()` — each call
 * produces a genuinely separate module evaluation (its own closure) that
 * nonetheless resolves the one shared `globalThis` record.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SdkInitResponse } from "@glasstrace/protocol";

const STORE_SYMBOL = Symbol.for("glasstrace.active-config");

function makeInitResponse(sideEffectEvidence: boolean): SdkInitResponse {
  return {
    config: {
      requestBodies: false,
      queryParamValues: false,
      envVarValues: false,
      fullConsoleOutput: false,
      importGraph: false,
      consoleErrors: false,
      errorResponseBodies: false,
      sideEffectEvidence,
      captureFidelity: "strict",
    },
    subscriptionStatus: "anonymous",
    minimumSdkVersion: "0.0.0",
    apiVersion: "v1",
    tierLimits: {
      tracesPerMinute: 100,
      storageTtlHours: 48,
      maxTraceSizeBytes: 512000,
      maxConcurrentSessions: 1,
    },
  } as SdkInitResponse;
}

/** A full-fidelity init response carrying a per-account HMAC key. */
function makeFullConfig(attrHmacKey: string): SdkInitResponse {
  const base = makeInitResponse(true);
  return {
    ...base,
    config: { ...base.config, captureFidelity: "full", attrHmacKey },
  } as SdkInitResponse;
}

/**
 * Loads a fresh evaluation of `init-client.js`. `vi.resetModules()` clears
 * Vitest's module registry so the next dynamic import re-evaluates the
 * module from scratch — a stand-in for a second bundle copy with its own
 * module-level closure. The `globalThis` singleton survives because it is
 * keyed on a process-global `Symbol.for()` symbol, not on module state.
 */
async function freshInitClientInstance(): Promise<
  typeof import("../../../packages/sdk/src/init-client.js")
> {
  vi.resetModules();
  return import("../../../packages/sdk/src/init-client.js");
}

describe("active-config store — cross-bundle-instance sharing", () => {
  beforeEach(async () => {
    const store = await import(
      "../../../packages/sdk/src/active-config-store.js"
    );
    store._resetActiveConfigForTesting();
    // Mark the disk-cache tier as already attempted so an empty-store read
    // (`isCaptureEnabled()` before any config is applied) resolves straight
    // to the fail-closed default instead of reading `.glasstrace/config`
    // from the test runner's cwd — which would make these assertions
    // depend on the developer's local filesystem.
    store.markConfigCacheChecked();
  });

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[STORE_SYMBOL];
    vi.resetModules();
  });

  it("a config applied in one module instance is visible to isCaptureEnabled() in another", async () => {
    // Instance A: the "init path" copy that applies the served config.
    const instanceA = await freshInitClientInstance();
    // Instance B: the "call-site" copy that the emitter would read.
    const instanceB = await freshInitClientInstance();

    // Distinct module evaluations: the two namespace objects are not the
    // same reference, so this is a real two-instance simulation rather
    // than a single cached module observed twice.
    expect(instanceA).not.toBe(instanceB);

    // Before any config is applied, the call-site copy fails closed.
    expect(instanceB.isCaptureEnabled()).toBe(false);

    // The init-path copy applies a served config with capture enabled.
    instanceA._setCurrentConfig(makeInitResponse(true));

    // The call-site copy — a different module instance — now observes it
    // through the shared singleton. This is the assertion that would fail
    // with plain module-level state (the original silent capture-drop).
    expect(instanceB.isCaptureEnabled()).toBe(true);
    expect(instanceA.isCaptureEnabled()).toBe(true);
  });

  it("getActiveConfig() in a second instance reflects the redacted shared config", async () => {
    const instanceA = await freshInitClientInstance();
    const instanceB = await freshInitClientInstance();

    // Plant a secret on the applied config to prove the public getter in a
    // second instance still redacts it (no new exposure via the singleton).
    instanceA._setCurrentConfig({
      ...makeInitResponse(true),
      config: {
        ...makeInitResponse(true).config,
        attrHmacKey: "super-secret-key",
      },
    } as SdkInitResponse);

    const seenByB = instanceB.getActiveConfig();
    expect(seenByB.sideEffectEvidence).toBe(true);
    expect("attrHmacKey" in seenByB).toBe(false);
  });

  it("holds the attrHmacKey in a closure: absent from the serialized record, but readable", async () => {
    const instanceA = await freshInitClientInstance();

    instanceA._setCurrentConfig({
      ...makeInitResponse(true),
      config: {
        ...makeInitResponse(true).config,
        captureFidelity: "full",
        attrHmacKey: "super-secret-key",
      },
    } as SdkInitResponse);

    // The key lives on the shared record behind a closure accessor (not an
    // enumerable field), so it is absent from a serialized dump of the record
    // even though it is intentionally reachable cross-copy via the accessor.
    // Capture flags ARE shared (so the gate works cross-instance); the raw
    // secret is just kept off the enumerable surface (no accidental logging).
    const record = (globalThis as Record<symbol, unknown>)[STORE_SYMBOL];
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("super-secret-key");

    const stored = record as { config?: { config?: Record<string, unknown> } };
    expect(stored.config?.config?.sideEffectEvidence).toBe(true);
    expect(stored.config?.config).not.toHaveProperty("attrHmacKey");

    // The applying instance recovers the key for id pseudonymization.
    expect(instanceA.getAttrHmacKey()).toBe("super-secret-key");
  });

  it("a reader instance reads the shared key applied by another bundle copy", async () => {
    const instanceA = await freshInitClientInstance();
    const instanceB = await freshInitClientInstance();

    // Instance A (the init-path copy) applies a full-fidelity config WITH a key.
    instanceA._setCurrentConfig(makeFullConfig("tenant-a-key"));

    // Instance B (a reader copy that never applied the config) — a different
    // module evaluation — sees `full` AND can read the key through the shared
    // record's closure holder. This is the cross-bundle fix: before, the key
    // was module-local to A, so B read `undefined` and id capture silently
    // dropped (no token AND no omission) under Turbopack dev.
    expect(instanceB.getActiveConfig().captureFidelity).toBe("full");
    expect(instanceB.getAttrHmacKey()).toBe("tenant-a-key");

    // A genuinely key-less `full` config (no key served) leaves the key unset,
    // so a reader gets `undefined` — the id path then records an `unhashed_id`
    // omission rather than a token.
    instanceA._setCurrentConfig({
      ...makeInitResponse(true),
      config: { ...makeInitResponse(true).config, captureFidelity: "full" },
    } as SdkInitResponse);
    expect(instanceB.getActiveConfig().captureFidelity).toBe("full");
    expect(instanceB.getAttrHmacKey()).toBeUndefined();
  });

  it("the latest applied key wins across instances (no stale per-copy key)", async () => {
    const instanceA = await freshInitClientInstance();
    const instanceB = await freshInitClientInstance();

    // Instance A applies a full-fidelity config with tenant A's key.
    instanceA._setCurrentConfig(makeFullConfig("tenant-a-key"));
    expect(instanceA.getAttrHmacKey()).toBe("tenant-a-key");

    // Instance B then applies a different full-fidelity config (a key rotation
    // or a dev key resolving to another tenant). There is a single shared key,
    // so the latest apply wins: BOTH copies read tenant B's key. No copy can
    // hash with a stale per-instance key, because there is no per-instance key.
    instanceB._setCurrentConfig(makeFullConfig("tenant-b-key"));
    expect(instanceA.getAttrHmacKey()).toBe("tenant-b-key");
    expect(instanceB.getAttrHmacKey()).toBe("tenant-b-key");
  });

  it("a later key-less config clears the shared key for every instance", async () => {
    const instanceA = await freshInitClientInstance();
    const instanceB = await freshInitClientInstance();

    instanceA._setCurrentConfig(makeFullConfig("tenant-a-key"));
    expect(instanceA.getAttrHmacKey()).toBe("tenant-a-key");

    // A later key-less config (a downgrade to strict, or a disk-cache promotion
    // that never carries the secret) clears the shared key (last-writer-wins),
    // so every copy reads `undefined`.
    instanceB._setCurrentConfig(makeInitResponse(true));
    expect(instanceA.getAttrHmacKey()).toBeUndefined();
    expect(instanceB.getAttrHmacKey()).toBeUndefined();
  });

  it("a reset in one instance clears the config for every instance", async () => {
    const instanceA = await freshInitClientInstance();
    const instanceB = await freshInitClientInstance();

    instanceA._setCurrentConfig(makeInitResponse(true));
    expect(instanceB.isCaptureEnabled()).toBe(true);

    // Resetting through one copy clears the shared record, so the other
    // copy fails closed again — confirming both share one record and
    // same-process tests cannot leak config across cases.
    instanceB._resetConfigForTesting();
    // The reset clears the whole record (including the cache-checked flag),
    // so re-mark it to keep the post-reset reads off the disk-cache tier
    // and independent of the runner's cwd.
    const store = await import(
      "../../../packages/sdk/src/active-config-store.js"
    );
    store.markConfigCacheChecked();
    expect(instanceA.isCaptureEnabled()).toBe(false);
    expect(instanceB.isCaptureEnabled()).toBe(false);
  });

  it("rotating the config through one instance is observed fresh by another (no memoization)", async () => {
    const instanceA = await freshInitClientInstance();
    const instanceB = await freshInitClientInstance();

    instanceA._setCurrentConfig(makeInitResponse(true));
    expect(instanceB.isCaptureEnabled()).toBe(true);

    // Rotate to a config with capture disabled; the read-fresh-each-call
    // semantics mean the other instance picks up the change on its next
    // read, not a stale cached value.
    instanceA._setCurrentConfig(makeInitResponse(false));
    expect(instanceB.isCaptureEnabled()).toBe(false);

    instanceA._setCurrentConfig(makeInitResponse(true));
    expect(instanceB.isCaptureEnabled()).toBe(true);
  });
});
