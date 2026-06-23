import type { SdkInitResponse } from "@glasstrace/protocol";

/**
 * Cross-bundle-instance store for the resolved active capture-config **and** the
 * per-account `attrHmacKey` secret.
 *
 * Why a `globalThis` singleton: under Turbopack `next dev` (HMR rebuilds) and
 * the edge-vs-node bundle split, the bundler can evaluate more than one copy of
 * this module in a single process. With plain module-level state, the copy that
 * the background init writes (`setActiveConfig`) is not necessarily the copy the
 * in-request emitter reads (`getActiveConfig` / `isCaptureEnabled` /
 * `getStoredAttrHmacKey`), so a served capture-config silently fails to reach
 * the call site and the gate falls through to the fail-closed default. Keying
 * the state on a `Symbol.for()` global symbol makes every bundle instance read
 * and write the same record. The brand survives module re-evaluation (Turbopack
 * HMR, Webpack `next dev`, Vitest module isolation). Per V8 semantics
 * `globalThis` is per-isolate, so Node `worker_threads` and `vm.Context` each
 * get a fresh slot and resolve their own config — the correct behavior.
 *
 * The per-account `attrHmacKey` lives here too, on the shared record, behind a
 * closure accessor. Glasstrace is a non-production (development-time) SDK, and
 * full-fidelity `*Id` pseudonymization must work in exactly the Turbopack-dev
 * bundle-split runtime above — the copy that runs the Prisma projection is
 * often not the copy that applied the config, so it must be able to read the
 * provisioned key. An earlier design kept the raw key in module-local state to
 * confine it to the applying copy (so arbitrary in-isolate code could not
 * recover it via the well-known symbol); that confinement is precisely what
 * broke cross-copy id capture. We deliberately relocate the key onto the shared
 * record: for a dev-only SDK the residual threat — other in-process code on a
 * developer's own machine reading a per-account hashing key that is already in
 * process memory — is low, and cross-copy reachability is required for the
 * feature to work at all. The key is held in a CLOSURE (see
 * {@link AttrHmacKeyHolder}), not an enumerable field, so it is absent from
 * `Object.keys` / `JSON.stringify` of the record and never lands in a casual
 * dump or log; it is intentionally reachable by code that calls the accessor.
 *
 * Edge-safety: this module touches only `globalThis` and a `Symbol.for` symbol.
 * It pulls in no Node built-in, no `@vercel/blob`, and never reaches the
 * `process` global, so it stays inside the F003 edge-safe contract enforced by
 * `scripts/check-edge-bundle.mjs`.
 */

/**
 * Branded discriminator on the stored record. Lets us detect at runtime whether
 * the value on `globalThis[STORE]` has the shape Glasstrace stores or is a
 * foreign value that happens to collide on the well-known symbol. A foreign or
 * shape-mismatched value is treated as a fresh store and overwritten rather
 * than trusted as config. This is a robustness guard, not a security boundary:
 * any code in the same isolate can write a conforming object to the slot.
 *
 * Bumped to `2` when the record shape changed: the per-account key moved onto
 * the record (behind a closure accessor), replacing the prior module-local-key
 * plus `keyToken`/`keyProvisioned` pairing design.
 */
const GLASSTRACE_BRAND = 2 as const;

/**
 * Process-wide (per-isolate) symbol under which the active-config record is
 * stored on `globalThis`, shared across every bundle instance in this isolate.
 */
const STORE = Symbol.for("glasstrace.active-config");

/**
 * Holds the per-account `attrHmacKey` in a closure rather than an enumerable
 * field, so the raw secret is absent from `Object.keys` / `JSON.stringify` of
 * the shared record (no accidental serialization or logging) while remaining
 * readable cross-copy by code that calls {@link AttrHmacKeyHolder.read}. Exactly
 * one holder is created per record (in {@link getStore}) and shared by every
 * bundle copy, so a `set` through one copy is observed by `read` in any other.
 */
interface AttrHmacKeyHolder {
  read(): string | undefined;
  set(key: string | undefined): void;
}

function createAttrHmacKeyHolder(): AttrHmacKeyHolder {
  let key: string | undefined;
  return {
    read: () => key,
    set: (next) => {
      key = next;
    },
  };
}

/**
 * Mutable record stored under `globalThis[STORE]`.
 *
 * - `config` — the latest successfully-resolved init response, or `null` when
 *   none has been applied yet. Carries no `attrHmacKey` secret — that is split
 *   off into {@link ActiveConfigRecord.attrHmacKeyHolder} on apply.
 * - `cacheChecked` — whether the synchronous disk-cache read has already been
 *   attempted this process (capped at most once so the export hot path never
 *   repeats synchronous I/O).
 * - `attrHmacKeyHolder` — the closure holding the per-account key, off the
 *   record's enumerable surface (see {@link AttrHmacKeyHolder}). Last-writer-
 *   wins: each `setActiveConfig` sets or clears it, so every bundle copy reads
 *   the currently-active key and no copy can hash with a stale/wrong-tenant key.
 *
 * All fields are mutated in place; the same record instance is reused for the
 * lifetime of the isolate, so a reference held by one bundle copy observes
 * writes made through any other copy.
 */
interface ActiveConfigRecord {
  readonly glasstraceActiveConfigBrand: typeof GLASSTRACE_BRAND;
  config: SdkInitResponse | null;
  cacheChecked: boolean;
  attrHmacKeyHolder: AttrHmacKeyHolder;
}

/**
 * Type-narrowing predicate that identifies a record Glasstrace itself stored.
 * Anything else — a primitive, an object missing the brand, an old
 * Glasstrace-shaped value with a different brand version, a value whose
 * `config` / `cacheChecked` fields are the wrong type, or one missing the
 * closure holder — is treated as "no store yet" so {@link getStore} replaces it
 * with a fresh record.
 */
function isActiveConfigRecord(value: unknown): value is ActiveConfigRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ActiveConfigRecord>;
  if (candidate.glasstraceActiveConfigBrand !== GLASSTRACE_BRAND) return false;
  if (typeof candidate.cacheChecked !== "boolean") return false;
  if (
    typeof candidate.attrHmacKeyHolder?.read !== "function" ||
    typeof candidate.attrHmacKeyHolder?.set !== "function"
  ) {
    return false;
  }
  return (
    candidate.config === null ||
    (typeof candidate.config === "object" && candidate.config !== undefined)
  );
}

/**
 * Returns the shared active-config record, installing a fresh one on
 * `globalThis` if none (or a foreign value) is present. Every reader and writer
 * in this module goes through here, so all bundle instances converge on the
 * same record (and the same {@link AttrHmacKeyHolder}).
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
    attrHmacKeyHolder: createAttrHmacKeyHolder(),
  };
  slot[STORE] = fresh;
  return fresh;
}

/**
 * The current resolved init response, or `null` when none has been applied.
 * Read fresh on every call so config/key rotation takes effect on the next read.
 */
export function getActiveConfigResponse(): SdkInitResponse | null {
  return getStore().config;
}

/**
 * Replaces the resolved init response and the per-account key. The non-secret
 * config is written to the shared record (visible to every bundle instance on
 * the next {@link getActiveConfigResponse}); the per-account `attrHmacKey`, if
 * present, is stored in the shared record's closure holder and removed from the
 * stored config object. Last-writer-wins: a later apply by any bundle copy —
 * key rotation, a different tenant, or a key-less downgrade / disk-cache
 * promotion — overwrites or clears the key, so no copy hashes with a stale key.
 * Passing `null` clears both.
 */
export function setActiveConfig(config: SdkInitResponse | null): void {
  const store = getStore();
  if (config === null) {
    store.config = null;
    store.attrHmacKeyHolder.set(undefined);
    return;
  }
  const innerKey = config.config.attrHmacKey;
  if (innerKey === undefined) {
    // No key in this config — including the key-less disk-cache promotion path
    // (`init-client.ts` strips the secret before caching). Clear any
    // previously-applied key so this key-less apply wins (last-writer-wins).
    store.config = config;
    store.attrHmacKeyHolder.set(undefined);
    return;
  }
  // Store a secret-free copy on the shared record. The clone is shallow at the
  // response level with a fresh `config` object so the stored value does not
  // alias the caller's object, and `attrHmacKey` is removed from that fresh
  // `config`; the secret goes into the closure holder, never an enumerable field.
  const { attrHmacKey: _omit, ...redactedInner } = config.config;
  void _omit;
  store.config = { ...config, config: redactedInner };
  store.attrHmacKeyHolder.set(innerKey);
}

/**
 * The per-account `attrHmacKey` for the config that is currently active across
 * all bundle instances, or `undefined` when none is provisioned. Read fresh on
 * every call (last-writer-wins). Held in the shared record's closure holder so
 * any bundle copy — including one that runs the Prisma projection without having
 * applied the config itself (the Turbopack-dev bundle split) — can read it.
 * Internal — not exported from the package barrel.
 */
export function getStoredAttrHmacKey(): string | undefined {
  return getStore().attrHmacKeyHolder.read();
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
 * Clears the shared active-config record (and with it the per-account key). For
 * testing only, so same-process test cases do not leak config across each other.
 * Mirrors `context-manager.ts`'s `_resetContextManagerForTesting`. Not exported
 * from the package barrel.
 *
 * @internal
 */
export function _resetActiveConfigForTesting(): void {
  delete (globalThis as Record<symbol, unknown>)[STORE];
}
