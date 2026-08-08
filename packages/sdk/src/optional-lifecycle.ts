/**
 * Edge-safe optional bridge to the SDK lifecycle event emitter.
 *
 * `./lifecycle.ts` imports `node:events` and is therefore excluded from
 * the F003 edge bundle (`packages/sdk/src/edge-entry.ts`,
 * `packages/sdk/scripts/check-edge-bundle.mjs`). Modules that need to
 * emit a lifecycle event AND need to ship in the edge bundle (e.g.,
 * `./middleware/index.ts`, `./async-context/index.ts`) cannot import
 * from `./lifecycle.ts` directly.
 *
 * This module is the bridge:
 *
 * - `lifecycle.ts` (Node-only) calls {@link _registerLifecycleEmitForBridge}
 *   inside `initLifecycle()`. The registration writes the typed
 *   `emitLifecycleEvent` reference to a `globalThis`-keyed slot.
 * - Edge-safe wrappers call {@link tryEmitLifecycleEvent}, which reads
 *   the slot. When unset (edge runtime, or SDK not yet initialized),
 *   the call is a clean no-op. When set, the call forwards to the
 *   real emitter.
 *
 * This file imports nothing from `node:*` and reads no `process`
 * globals; it is admissible to the edge bundle by the F003 contract.
 *
 * The slot key uses `Symbol.for()` so the bridge survives module
 * re-evaluation (Turbopack HMR rebuilds, Webpack `next dev` rebuilds,
 * vitest module isolation). The same pattern is used by the OTel
 * context-manager guard at `./context-manager.ts:28` and the exporter
 * brand at `./coexistence.ts:31` — all three are per-isolate by V8
 * semantics, which is the correct boundary for this contract (a Node
 * worker thread or `vm.Context` is logically a fresh process).
 *
 * Bridge-contract versioning
 * --------------------------
 * The slot key carries a BRIDGE-CONTRACT version suffix (`.v1`).
 * **Binding key-bump policy:** any incompatible change to the bridge's
 * payload or callback contract (the {@link LifecycleEmitFn} shape or
 * the meaning of its arguments) MUST bump the suffix in the same
 * change. The versioned key scopes mixed-version behavior precisely:
 * SDK releases sharing a bridge-contract version deliberately share
 * the slot — their payloads are compatible by that contract — while a
 * pre-versioning release and any release on a DIFFERENT contract
 * version do not collide: each release reads and writes only its own
 * key, finding either a slot registered under its own contract or
 * nothing, and a missing slot is the safe no-op degradation
 * documented on {@link tryEmitLifecycleEvent}. The suffix does NOT
 * isolate every co-resident SDK version pair; releases on the same
 * contract version still share one slot, latest registration winning.
 *
 * **Why not pass the emitter through the public wrapper API?** The
 * emitter is an internal SDK signal, not a user-facing knob. Keeping
 * it on a global slot rather than as a wrapper option preserves the
 * documented public surface (`tracedRequestMiddleware(options,
 * handler)`) and lets the lifecycle module take ownership of the
 * emit-once / event-key invariants without exposing them.
 */

/**
 * Process-wide brand used to look up the registered emit function.
 * The `.v1` suffix is the bridge-contract version — see the module
 * doc's binding key-bump policy before changing the emit signature.
 */
const EMIT_BRIDGE = Symbol.for("glasstrace.lifecycle.emit-bridge.v1");

/**
 * Type of the registered emit function. Mirrors the signature of
 * `emitLifecycleEvent` from `./lifecycle.ts` but stringly-typed here
 * to keep this module free of any cross-import that would couple the
 * edge bundle to `node:events`.
 *
 * The bridge wire is deliberately untyped: the lifecycle module's
 * registered callback runtime-verifies the event name against its own
 * known-event set and drops unknown names, casting only the payload
 * at that verified boundary. Callers of {@link tryEmitLifecycleEvent}
 * pass plain strings.
 */
export type LifecycleEmitFn = (
  event: string,
  payload: Record<string, unknown>,
) => void;

interface BridgeSlot {
  readonly emit: LifecycleEmitFn;
}

/**
 * INTERNAL — called by `./lifecycle.ts` during `initLifecycle()` to
 * register the emit function under the global slot. Calling twice is
 * idempotent: the latest registration wins. Never throws.
 */
export function _registerLifecycleEmitForBridge(
  emit: LifecycleEmitFn,
): void {
  try {
    const slot: BridgeSlot = { emit };
    (globalThis as unknown as Record<symbol, BridgeSlot>)[EMIT_BRIDGE] = slot;
  } catch {
    // Defensive: writing to globalThis is observable; some constrained
    // sandboxes freeze it. The bridge falls back to silent no-op.
  }
}

/**
 * INTERNAL — called by `./lifecycle.ts` during
 * `resetLifecycleForTesting()` to clear the slot so a fresh test gets
 * a clean bridge state.
 */
export function _clearLifecycleEmitForBridge(): void {
  try {
    delete (globalThis as unknown as Record<symbol, unknown>)[EMIT_BRIDGE];
  } catch {
    // Defensive: see _registerLifecycleEmitForBridge.
  }
}

/**
 * Attempt to emit a lifecycle event through the registered bridge.
 *
 * - When the lifecycle module has registered the bridge (Node runtime
 *   with `registerGlasstrace()` having run): forwards to
 *   `emitLifecycleEvent(event, payload)` (the registered callback
 *   drops event names outside its release's known set).
 * - When the bridge is unset (edge runtime — `lifecycle.ts` not in
 *   closure; or pre-`initLifecycle()` race): no-op.
 *
 * Errors thrown by the registered emit function are swallowed —
 * instrumentation must never break a user request hook.
 */
export function tryEmitLifecycleEvent(
  event: string,
  payload: Record<string, unknown>,
): void {
  try {
    const slot = (globalThis as unknown as Record<symbol, BridgeSlot | undefined>)[
      EMIT_BRIDGE
    ];
    if (!slot) return;
    slot.emit(event, payload);
  } catch {
    // Swallow — bridge failures are advisory, not fatal.
  }
}
