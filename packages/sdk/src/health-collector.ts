import type { SdkHealthReport } from "@glasstrace/protocol";

// --- Module-level state (singleton pattern matching init-client.ts) ---

/** Spans successfully forwarded to the delegate exporter since last collect. */
let tracesExported = 0;

/** Spans dropped: buffer overflow evictions + spans lost on shutdown. */
let tracesDropped = 0;

/** Failed performInit attempts since last collect. */
let initFailures = 0;

/** Timestamp (ms) of the last successful config sync (performInit success or cached config load). */
let lastConfigSyncAt: number | null = null;

// --- Recording functions (called by other modules) ---

/**
 * Records that spans were submitted to the delegate exporter.
 * Counts submission, not confirmed delivery (DISC-1118).
 * Called by GlasstraceExporter after delegate.export() is invoked.
 */
export function recordSpansExported(count: number): void {
  if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) return;
  tracesExported += count;
}

/**
 * Records that spans were dropped (buffer overflow eviction or shutdown loss).
 * Called by GlasstraceExporter on buffer eviction and unresolved-key shutdown.
 */
export function recordSpansDropped(count: number): void {
  if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) return;
  tracesDropped += count;
}

/**
 * Records a failed performInit attempt.
 * Called by performInit when the init request fails for any reason.
 */
export function recordInitFailure(): void {
  try { initFailures += 1; } catch { /* best-effort */ }
}

/**
 * Records the timestamp of a successful config sync.
 * Called by performInit on success and by loadCachedConfig when loading a valid cache.
 */
export function recordConfigSync(timestamp: number): void {
  try { lastConfigSyncAt = timestamp; } catch { /* best-effort */ }
}

// --- Collection ---

/**
 * Snapshots the current health metrics into an SdkHealthReport without
 * resetting counters. Counters are only reset when {@link acknowledgeHealthReport}
 * is called after the init request succeeds. This two-phase approach prevents
 * metric loss when `performInit` fails — the counters persist for the next
 * init attempt.
 *
 * On the first init call, all counters will be zero, which is correct.
 *
 * @param sdkVersion - The SDK version string to include in the report.
 * @returns The health report, or null if collection fails unexpectedly.
 */
export function collectHealthReport(sdkVersion: string): SdkHealthReport | null {
  try {
    const now = Date.now();
    const configAge = lastConfigSyncAt !== null ? Math.max(0, now - lastConfigSyncAt) : 0;

    return {
      tracesExportedSinceLastInit: tracesExported,
      tracesDropped,
      initFailures,
      configAge: Math.round(configAge),
      sdkVersion,
    };
  } catch {
    return null;
  }
}

/**
 * Subtracts the reported values from the running counters after a health
 * report has been successfully delivered to the backend. Called by
 * `performInit` on the success path. If init fails, counters persist
 * for the next attempt.
 *
 * Uses subtraction instead of zeroing to preserve any increments that
 * occurred between the snapshot (`collectHealthReport`) and delivery
 * (e.g., spans exported during the init HTTP call). Values are clamped
 * to 0 to guard against edge cases.
 *
 * Core invariant (DISC-1123): for any finite counter C and finite reported
 * value, after acknowledge:
 *   C_new = max(0, C_before_ack - reported_value)
 * This guarantees:
 *   1. Reported finite, non-negative values are removed exactly once
 *      (no double-counting).
 *   2. Activity between snapshot and acknowledge is preserved (not lost).
 *   3. The counter never goes negative (clamp prevents underflow).
 * Corruption vectors guarded: non-finite report fields (NaN/±Infinity)
 * preserve the counter; negative finite report fields are clamped to 0
 * before subtraction.
 *
 * `lastConfigSyncAt` is NOT affected — config age measures time since
 * the last successful sync, not the last acknowledgment.
 */
export function acknowledgeHealthReport(report: SdkHealthReport): void {
  const exp = Math.max(0, report.tracesExportedSinceLastInit);
  const expVal = tracesExported - exp;
  tracesExported = Number.isFinite(expVal) ? Math.max(0, expVal) : tracesExported;

  const drop = Math.max(0, report.tracesDropped);
  const dropVal = tracesDropped - drop;
  tracesDropped = Number.isFinite(dropVal) ? Math.max(0, dropVal) : tracesDropped;

  const fail = Math.max(0, report.initFailures);
  const failVal = initFailures - fail;
  initFailures = Number.isFinite(failVal) ? Math.max(0, failVal) : initFailures;
}

// --- Test support ---

/**
 * Resets all health metrics to initial state. For testing only.
 */
export function _resetHealthForTesting(): void {
  tracesExported = 0;
  tracesDropped = 0;
  initFailures = 0;
  lastConfigSyncAt = null;
}
