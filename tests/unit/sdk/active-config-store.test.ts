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

  it("never places the attrHmacKey secret on the well-known global symbol", async () => {
    const instanceA = await freshInitClientInstance();

    instanceA._setCurrentConfig({
      ...makeInitResponse(true),
      config: {
        ...makeInitResponse(true).config,
        captureFidelity: "full",
        attrHmacKey: "super-secret-key",
      },
    } as SdkInitResponse);

    // The shared record is reachable by any in-isolate code via the
    // well-known symbol. Walk every field of the stored value and assert
    // the secret is nowhere in it — confirming the split keeps the tenant
    // secret off the global slot. Capture flags ARE shared (so the gate
    // works cross-instance); only the secret is withheld.
    const record = (globalThis as Record<symbol, unknown>)[STORE_SYMBOL];
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("super-secret-key");

    const stored = record as { config?: { config?: Record<string, unknown> } };
    expect(stored.config?.config?.sideEffectEvidence).toBe(true);
    expect(stored.config?.config).not.toHaveProperty("attrHmacKey");

    // The applying instance can still recover the key for id pseudonymization
    // (it lives in module-local state, not on the global record).
    expect(instanceA.getAttrHmacKey()).toBe("super-secret-key");
  });

  it("marks the account key-provisioned for a reader instance that lacks the local key", async () => {
    const instanceA = await freshInitClientInstance();
    const instanceB = await freshInitClientInstance();

    // Instance A applies a full-fidelity config WITH a key. The key is local
    // to A; the shared record carries only the non-secret provisioned flag.
    instanceA._setCurrentConfig(makeFullConfig("tenant-a-key"));

    // Instance B (a reader copy that never applied) sees `full` and
    // key-provisioned=true, but cannot read the key. This lets the id path
    // distinguish "key applied in another bundle copy" (behave like strict)
    // from a genuinely key-less `full` account (record the observable
    // misconfiguration omission). B has no local key, but the account IS
    // provisioned.
    expect(instanceB.getActiveConfig().captureFidelity).toBe("full");
    expect(instanceB.getAttrHmacKey()).toBeUndefined();
    expect(instanceB.isAttrHmacKeyProvisioned()).toBe(true);

    // A genuinely key-less `full` config (no key served) reports
    // key-provisioned=false, so the id path records the omission instead.
    instanceA._setCurrentConfig({
      ...makeInitResponse(true),
      config: { ...makeInitResponse(true).config, captureFidelity: "full" },
    } as SdkInitResponse);
    expect(instanceB.getActiveConfig().captureFidelity).toBe("full");
    expect(instanceB.isAttrHmacKeyProvisioned()).toBe(false);
  });

  it("invalidates a stale module-local key after another instance applies a different config", async () => {
    const instanceA = await freshInitClientInstance();
    const instanceB = await freshInitClientInstance();

    // Instance A applies a full-fidelity config with tenant A's key.
    instanceA._setCurrentConfig(makeFullConfig("tenant-a-key"));
    expect(instanceA.getAttrHmacKey()).toBe("tenant-a-key");

    // Instance B then applies a different full-fidelity config (e.g. a key
    // rotation or a dev key resolving to another tenant). This overwrites the
    // shared pairing token.
    instanceB._setCurrentConfig(makeFullConfig("tenant-b-key"));

    // Instance A's cached key is now stale: its pairing token no longer
    // matches the shared record, so the getter fail-closes to undefined
    // instead of hashing identifiers with the wrong account's key. Instance B,
    // the latest applier, still gets its own key.
    expect(instanceA.getAttrHmacKey()).toBeUndefined();
    expect(instanceB.getAttrHmacKey()).toBe("tenant-b-key");
  });

  it("invalidates a stale module-local key when a later config carries no key", async () => {
    const instanceA = await freshInitClientInstance();
    const instanceB = await freshInitClientInstance();

    instanceA._setCurrentConfig(makeFullConfig("tenant-a-key"));
    expect(instanceA.getAttrHmacKey()).toBe("tenant-a-key");

    // A later keyless config (e.g. a downgrade to strict, or a disk-cache
    // promotion that never carries the secret) clears the shared token.
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
