/**
 * Coexistence state for the signal handler.
 *
 * Set by configureOtel() once the async provider probe completes:
 *   - "sole-owner"  — Glasstrace owns the OTel provider (Scenarios A / E).
 *                     The signal handler re-raises after draining hooks.
 *   - "coexisting"  — Another provider exists (Scenario B / C / F).
 *                     The signal handler drains our hooks but does NOT
 *                     re-raise, so the existing provider's shutdown can
 *                     complete at its own pace.
 *   - "unknown"     — The async probe has not completed yet (startup window).
 *                     Treated the same as "sole-owner" — re-raise is the
 *                     safe default because it preserves the process's default
 *                     signal semantics when we have no information.
 */
type CoexistenceState = "unknown" | "sole-owner" | "coexisting";

let coexistenceState: CoexistenceState = "unknown";

/**
 * Called by configureOtel() once the async provider probe completes.
 * "sole-owner" when Glasstrace owns the provider; "coexisting" otherwise.
 */
export function setCoexistenceState(s: CoexistenceState): void {
  coexistenceState = s;
}

/**
 * Returns the current coexistence state.
 * "unknown" until configureOtel() completes its async provider probe.
 */
export function getCoexistenceState(): CoexistenceState {
  return coexistenceState;
}

/**
 * Resets coexistence state to "unknown". For testing only.
 */
export function _resetCoexistenceStateForTesting(): void {
  coexistenceState = "unknown";
}
