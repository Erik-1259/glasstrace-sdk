import type { SdkInitResponse } from "@glasstrace/protocol";

/**
 * Module-local holder for the per-account `attrHmacKey` secret.
 *
 * The secret is deliberately NOT placed on the shared `globalThis` record:
 * that record is keyed on a `Symbol.for()` global symbol, which any code in
 * the same isolate can recover, so storing the raw key there would let
 * arbitrary in-process code read the tenant secret — defeating the public
 * getter's redaction. Keeping it in module-local state preserves the
 * pre-singleton confinement of the secret (a module-local closure, not a
 * well-known global slot). The trade-off is that the secret is not shared
 * across bundle instances; the only consumer (full-fidelity id
 * pseudonymization) already fail-closes to an omission marker when the key
 * is absent, so a bundle copy that did not apply the config simply records
 * the omission instead of leaking or crashing.
 */
let attrHmacKey: string | undefined;

/**
 * Identity token pairing this module instance's {@link attrHmacKey} to the
 * specific config-apply it came from.
 *
 * Each config-apply that carries a key mints a fresh, opaque object and
 * stores the SAME reference both here (module-local) and on the shared
 * record's `keyToken` (non-secret — it is an empty marker object, not the
 * key). {@link getStoredAttrHmacKey} returns the local key only while
 * `localKeyToken === store.keyToken`, i.e. while this instance's key still
 * matches the config that is currently active across all instances.
 *
 * This closes the stale-key window: if another bundle copy later applies a
 * different config (key rotation, a dev key resolving to a different tenant,
 * or any later init), it overwrites `store.keyToken`, so this instance's now-
 * stale key no longer matches and the getter fail-closes to `undefined`
 * rather than hashing identifiers with the wrong account's key. An object
 * reference is used (not a counter or random value) because reference
 * identity is exact, needs no randomness/crypto, and stays edge-safe.
 */
let localKeyToken: object | undefined;

/**
 * Cross-bundle-instance store for the resolved active capture-config.
 *
 * Why a `globalThis` singleton and not a module-level `let`: under
 * Turbopack `next dev` (HMR rebuilds) and the edge-vs-node bundle split,
 * the bundler can evaluate more than one copy of the config module in a
 * single process. With plain module-level state, the copy that the
 * background init writes (`setActiveConfig`) is not necessarily the copy
 * that the in-request emitter reads (`getActiveConfig` / `isCaptureEnabled`),
 * so a served capture-config silently fails to reach the call site and
 * the gate falls through to the fail-closed default.
 *
 * Keying the state on a `Symbol.for()` global symbol makes every bundle
 * instance read and write the same record, so a config applied in one
 * copy is immediately visible in every other. The brand survives module
 * re-evaluation (Turbopack HMR rebuilds, Webpack `next dev` rebuilds,
 * Vitest module isolation) for the same reason the context-manager guard
 * does. Per V8 semantics `globalThis` is per-isolate, so Node
 * `worker_threads` and `vm.Context` each get a fresh slot — that is the
 * correct behavior, since a worker is a logically separate process and
 * should resolve its own config.
 *
 * Edge-safety: this module touches only `globalThis` and a `Symbol.for`
 * symbol. It pulls in no Node built-in, no `@vercel/blob`, and never
 * reaches the `process` global, so it stays inside the F003 edge-safe
 * contract enforced by `scripts/check-edge-bundle.mjs`.
 */

/**
 * Branded discriminator on the stored record. Lets us detect at runtime
 * whether the value on `globalThis[STORE]` has the shape Glasstrace stores
 * or is a foreign value that happens to collide on the well-known symbol
 * (an unrelated library, a corrupted slot). A foreign or shape-mismatched
 * value is treated as a fresh store and overwritten rather than trusted as
 * config, so an accidental collision degrades to a clean re-init instead of
 * a malformed read. This is a robustness guard, not a security boundary:
 * any code in the same isolate can write a conforming object to the slot.
 */
const GLASSTRACE_BRAND = 1 as const;

/**
 * Process-wide (per-isolate) symbol under which the active-config record
 * is stored on `globalThis`. Mirrors the `Symbol.for` brand mechanism
 * used by the context-manager guard so the state is shared across every
 * bundle instance the bundler evaluates in this isolate.
 */
const STORE = Symbol.for("glasstrace.active-config");

/**
 * Mutable record stored under `globalThis[STORE]`.
 *
 * - `config` — the latest successfully-resolved init response, or `null`
 *   when none has been applied yet (cold start before the first init /
 *   disk-cache read). Carries no `attrHmacKey` secret — that is split off
 *   into module-local state on apply.
 * - `cacheChecked` — whether the synchronous disk-cache read has already
 *   been attempted this process. Caps the read at most once per process
 *   so the export hot path never repeats synchronous I/O.
 * - `keyToken` — an opaque, non-secret marker identifying which config-apply
 *   the active `attrHmacKey` secret belongs to. Used to detect a stale
 *   module-local key after another bundle copy applies a different config;
 *   `undefined` when the active config has no key. Never holds the secret.
 * - `keyProvisioned` — whether the active config was served WITH an
 *   `attrHmacKey` (the key value itself stays module-local). Non-secret —
 *   it is a boolean, not the key. Lets a reader instance distinguish a
 *   genuinely key-less `full` account (an observable misconfiguration) from
 *   a `full` account whose key was applied in a different bundle copy (a
 *   cross-instance artifact that should behave like strict, not emit a
 *   spurious unhashed-id omission).
 *
 * All fields are mutated in place; the same record instance is reused for
 * the lifetime of the isolate, so a reference held by one bundle copy
 * observes writes made through any other copy.
 */
interface ActiveConfigRecord {
  readonly glasstraceActiveConfigBrand: typeof GLASSTRACE_BRAND;
  config: SdkInitResponse | null;
  cacheChecked: boolean;
  keyToken: object | undefined;
  keyProvisioned: boolean;
}

/**
 * Type-narrowing predicate that identifies a record Glasstrace itself
 * stored. Anything else — a primitive, an object missing the brand, an
 * old Glasstrace-shaped value with a different brand version, or a value
 * whose `config` / `cacheChecked` fields are the wrong type — is treated
 * as "no store yet" so {@link getStore} replaces it with a fresh record.
 *
 * The `config` and `cacheChecked` shape checks matter: `resolveActiveConfig`
 * dereferences `record.config.config`, so accepting a record whose `config`
 * is a non-object/non-null value would let a corrupt slot produce undefined
 * reads downstream. Validating the field types keeps a malformed slot from
 * being trusted; it is overwritten with a fresh record instead.
 */
function isActiveConfigRecord(value: unknown): value is ActiveConfigRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ActiveConfigRecord>;
  if (candidate.glasstraceActiveConfigBrand !== GLASSTRACE_BRAND) return false;
  if (typeof candidate.cacheChecked !== "boolean") return false;
  return (
    candidate.config === null ||
    (typeof candidate.config === "object" && candidate.config !== undefined)
  );
}

/**
 * Returns the shared active-config record, installing a fresh one on
 * `globalThis` if none (or a foreign value) is present. Every reader and
 * writer in this module goes through here, so all bundle instances
 * converge on the same record.
 */
function getStore(): ActiveConfigRecord {
  const slot = globalThis as Record<symbol, unknown>;
  const existing = slot[STORE];
  if (isActiveConfigRecord(existing)) {
    return existing;
  }
  const fresh: ActiveConfigRecord = {
    glasstraceActiveConfigBrand: GLASSTRACE_BRAND,
    config: null,
    cacheChecked: false,
    keyToken: undefined,
    keyProvisioned: false,
  };
  slot[STORE] = fresh;
  return fresh;
}

/**
 * The current resolved init response, or `null` when none has been
 * applied. Read fresh on every call so config/key rotation takes effect
 * on the next read.
 */
export function getActiveConfigResponse(): SdkInitResponse | null {
  return getStore().config;
}

/**
 * Replaces the resolved init response. Used by the init success path, the
 * orchestrator setter, and the disk-cache promotion. The non-secret config
 * is written to the shared record (visible to every bundle instance on the
 * next {@link getActiveConfigResponse}); the per-account `attrHmacKey`
 * secret, if present, is split off into module-local state and never placed
 * on the shared `globalThis` record. A fresh pairing token is stored on the
 * shared record so a later apply by any bundle copy invalidates this copy's
 * now-stale key. Passing `null` clears both.
 */
export function setActiveConfig(config: SdkInitResponse | null): void {
  const store = getStore();
  if (config === null) {
    store.config = null;
    store.keyToken = undefined;
    store.keyProvisioned = false;
    attrHmacKey = undefined;
    localKeyToken = undefined;
    return;
  }
  const innerKey = config.config.attrHmacKey;
  if (innerKey === undefined) {
    // No key in this config: clear the shared pairing token so any other
    // copy's previously-applied key is treated as stale, and drop our own.
    // `keyProvisioned: false` marks a key-less account, so a reader of a
    // `full` posture here records the observable misconfiguration omission.
    store.config = config;
    store.keyToken = undefined;
    store.keyProvisioned = false;
    attrHmacKey = undefined;
    localKeyToken = undefined;
    return;
  }
  // Mint a fresh, opaque pairing token shared between this instance's local
  // key and the shared record. A later apply (here or in any other copy)
  // overwrites `store.keyToken`, so a stale local key stops matching.
  const token = {};
  attrHmacKey = innerKey;
  localKeyToken = token;
  // Store a secret-free copy on the shared record. The clone is shallow at
  // the response level with a fresh `config` object so the stored value does
  // not alias the caller's object, and `attrHmacKey` is removed from that
  // fresh `config`. No other field carries the secret.
  const { attrHmacKey: _omit, ...redactedInner } = config.config;
  void _omit;
  store.config = { ...config, config: redactedInner };
  store.keyToken = token;
  // The account IS key-provisioned even though the secret stays module-local.
  // A reader instance without the local key uses this to behave like strict
  // (skip id projection) instead of recording a spurious unhashed-id omission.
  store.keyProvisioned = true;
}

/**
 * The per-account `attrHmacKey` secret for the config that is currently
 * active across all bundle instances, or `undefined` when none is
 * provisioned, none was applied in this instance, or this instance's key has
 * been superseded by a later apply from another copy. Held in module-local
 * state, deliberately off the shared `globalThis` record. Internal — not
 * exported from the package barrel.
 *
 * Returns the local key only while its pairing token still matches the shared
 * record's `keyToken`. If another copy applied a different config after this
 * instance cached its key, the tokens diverge and this returns `undefined` —
 * so the full-fidelity id path fail-closes to an omission marker rather than
 * pseudonymizing with a stale/wrong-tenant key.
 */
export function getStoredAttrHmacKey(): string | undefined {
  if (attrHmacKey === undefined) return undefined;
  if (localKeyToken === undefined) return undefined;
  return localKeyToken === getStore().keyToken ? attrHmacKey : undefined;
}

/**
 * Whether the active config was served WITH a per-account `attrHmacKey`,
 * regardless of whether the key is available in this bundle instance.
 *
 * Lets the id-projection path tell two `full`-posture states apart when the
 * local key is unavailable:
 *   - `false` — the account is genuinely key-less (the backend served `full`
 *     with no key): an observable misconfiguration, so the caller records the
 *     `unhashed_id` omission.
 *   - `true` — the key was applied in a different bundle copy and is simply
 *     not local here: a cross-instance artifact, so the caller behaves like
 *     strict (skips id projection) instead of emitting a spurious omission.
 *
 * Internal — not exported from the package barrel.
 */
export function isAttrHmacKeyProvisioned(): boolean {
  return getStore().keyProvisioned;
}

/**
 * Whether the synchronous disk-cache read has already been attempted this
 * process.
 */
export function isConfigCacheChecked(): boolean {
  return getStore().cacheChecked;
}

/** Marks the synchronous disk-cache read as attempted for this process. */
export function markConfigCacheChecked(): void {
  getStore().cacheChecked = true;
}

/**
 * Clears the shared active-config record. For testing only, so
 * same-process test cases do not leak config across each other. Mirrors
 * `context-manager.ts`'s `_resetContextManagerForTesting`. Not exported
 * from the package barrel.
 *
 * @internal
 */
export function _resetActiveConfigForTesting(): void {
  delete (globalThis as Record<symbol, unknown>)[STORE];
  attrHmacKey = undefined;
  localKeyToken = undefined;
}
