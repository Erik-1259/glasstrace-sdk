/**
 * Decision tracing — make the SDK's silent config-decision points
 * observable behind a single ON/OFF toggle that defaults OFF.
 *
 * Many of the SDK's capture / emit / redact decisions are decided
 * silently: when capture produces nothing, an operator or a validator
 * cannot tell *which* config gate closed. This module adds a thin,
 * behavior-neutral emitter that every instrumented gate calls at the
 * moment it decides. It routes through the SDK's existing plumbing — the
 * internal console logger (`sdkLog`) for human debugging and the
 * in-process lifecycle bus (`core:decision`) for programmatic
 * assertions — so no new logging subsystem is introduced.
 *
 * The emitter is a strict no-op when the toggle is OFF, never changes a
 * branch outcome, never throws into the caller, and never prints a
 * secret or a rejected value.
 *
 * This module reads `process.env` directly (the early-bootstrap gate
 * below), so it is **Node-only by design** and must not be wired into
 * the edge bundle or any `/edge` subpath export.
 */

import { sdkLog } from "./console-capture.js";
import { emitLifecycleEvent } from "./lifecycle.js";
import { getCorrelationBuildHash } from "./build-info.js";

/**
 * The stable diagnostic id of an instrumented SDK decision point.
 *
 * Part of the SDK's stable diagnostic contract: existing members are
 * immutable (validators and tests match on them); the union may be
 * extended with new points in a minor release. Ids are case-sensitive,
 * dot-separated, camelCase components (for example
 * `capture.fidelity.hmacKey`) — the dotted path mirrors the config
 * surface the gate reads.
 *
 * The full Priority 1–5 inventory is declared here up front so later
 * call-site additions do not widen the union.
 *
 * @internal
 */
export type DecisionPoint =
  | "capture.sideEffectEvidence"
  | "capture.fidelity.identifier"
  | "capture.fidelity.idModel"
  | "capture.fidelity.hmacKey"
  | "config.tier"
  | "sideEffect.fieldRejected"
  | "feature.consoleErrors"
  | "feature.errorResponseBodies"
  | "feature.discovery"
  | "otel.path"
  | "env.forceEnable"
  | "env.nudgeSuppressed"
  | "env.upgradeNoticeSuppressed";

/**
 * Optional detail for a decision emission.
 *
 * @internal
 */
export interface DecisionDetail {
  /** Short, bounded reason from a closed, code-literal vocabulary. */
  reason?: string;
  /**
   * Bounded, safe disambiguation tokens. Keys are always code-literals
   * (never producer input); values follow the sensitive-value rule
   * (never a raw secret, never a rejected value).
   */
  inputs?: Record<string, string | number | boolean>;
  /** Dedup key for hot-path gates; when present, the line emits at most once per key. */
  oneShotKey?: string;
}

/** Maximum number of distinct one-shot keys retained (bounded memory). */
const _DEDUP_MAX_KEYS = 100;

/** Maximum number of `inputs` keys rendered (extra keys dropped in insertion order). */
const _MAX_INPUT_KEYS = 8;

/** Maximum UTF-8 byte length of a rendered `inputs` value before truncation. */
const _MAX_INPUT_VALUE_BYTES = 100;

/**
 * Number of characters of the build hash included in the correlation
 * stamp. The full hash is typically a 40-char SHA; a short prefix is
 * enough to correlate a decision line with a deployment.
 */
const _BUILD_HASH_PREFIX_LEN = 12;

/**
 * The resolved decision-trace flag, set by `registerGlasstrace()` after
 * `resolveConfig()` runs (mirrors `setSideEffectVerboseFlag`). `null`
 * means "not yet resolved" — before the threaded flag is set, the gate
 * falls back to the raw env var so early-bootstrap emissions are not
 * silently dropped. Holds the folded `decisionTrace || verbose` value
 * once set.
 */
let _flag: boolean | null = null;

/** One-shot keys already emitted this process, bounded by `_DEDUP_MAX_KEYS`. */
const _seenKeys = new Set<string>();

/**
 * Set the resolved decision-trace flag. Called from `registerGlasstrace()`
 * with `decisionTrace || verbose`. Not exposed from the public package
 * barrel — internal coordination only.
 *
 * @internal
 */
export function setDecisionTraceFlag(enabled: boolean): void {
  _flag = enabled;
}

/**
 * The single decision-trace gate. Returns `true` when decision tracing
 * is on.
 *
 * Two phases share one predicate:
 *
 *   - **After `setDecisionTraceFlag` has run** (the common case), the
 *     resolved, folded flag governs — `decisionTrace || verbose`.
 *   - **Before it runs** (decisions decided during early bootstrap, before
 *     `setDecisionTraceFlag` is threaded, such as
 *     `env.upgradeNoticeSuppressed`), the resolved flag does not yet exist,
 *     so the gate reads the raw env var directly. This is correct by
 *     necessity: `verbose` comes from resolved config that does not exist
 *     that early, so the env var (`GLASSTRACE_DECISION_TRACE`) is the only
 *     available pre-config signal — such a point is reachable only via the
 *     env var, not the programmatic `decisionTrace` / `verbose` option.
 *
 * @internal
 */
export function decisionTraceEnabled(): boolean {
  if (_flag !== null) return _flag;
  return process.env.GLASSTRACE_DECISION_TRACE === "true";
}

/**
 * Emit a single decision-trace line (and, when subscribed, a
 * `core:decision` lifecycle event) for an instrumented decision point.
 *
 * No-op when the toggle is OFF. On hot paths the caller MUST additionally
 * guard with `decisionTraceEnabled()` before building `detail`, because
 * the `detail` argument is evaluated before this function is entered —
 * the first-line guard here is defence-in-depth for cold paths and a
 * missed call-site guard, not a substitute for the call-site guard.
 *
 * The whole body is fenced: a throwing host `console` or lifecycle
 * listener can never disrupt the behavior-neutral path.
 *
 * @internal
 */
export function decisionTrace(
  point: DecisionPoint,
  outcome: string,
  detail?: DecisionDetail,
): void {
  if (!decisionTraceEnabled()) return;

  try {
    // One-shot / dedup on hot paths. Once the cap is reached, new keys
    // are silently skipped — better to lose a late line than grow without
    // bound. A key seen before suppresses the repeat.
    const key = detail?.oneShotKey;
    if (key !== undefined) {
      if (_seenKeys.has(key)) return;
      if (_seenKeys.size >= _DEDUP_MAX_KEYS) return;
      _seenKeys.add(key);
    }

    const safeInputs = boundInputs(detail?.inputs);

    sdkLog("info", formatLine(point, outcome, detail?.reason, safeInputs));

    emitLifecycleEvent("core:decision", {
      point,
      outcome,
      ...(detail?.reason !== undefined ? { reason: detail.reason } : {}),
      ...(safeInputs !== undefined ? { inputs: safeInputs } : {}),
    });
  } catch {
    // Diagnostic deliverability is best-effort; never propagate into the
    // caller's path.
  }
}

/**
 * Apply the `inputs` bounds: at most `_MAX_INPUT_KEYS` keys (extra keys
 * dropped in insertion order); each value coerced to a string/number/
 * boolean with string values truncated to `_MAX_INPUT_VALUE_BYTES` UTF-8
 * bytes (trailing `…` when truncated); `undefined` / `null` values
 * omitted. Returns `undefined` when nothing survives so the caller can
 * omit the field entirely.
 */
function boundInputs(
  inputs: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (inputs === undefined) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const k of Object.keys(inputs)) {
    if (count >= _MAX_INPUT_KEYS) break;
    const v = inputs[k];
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? truncateUtf8(v, _MAX_INPUT_VALUE_BYTES) : v;
    count++;
  }
  return count > 0 ? out : undefined;
}

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes, appending a
 * trailing `…` when truncation occurred. Truncates on a character
 * boundary so a multi-byte code point is never split.
 */
function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;
  let out = "";
  let bytes = 0;
  for (const ch of value) {
    const chBytes = encoder.encode(ch).length;
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out + "…";
}

/**
 * Render the single decision line:
 * `[glasstrace] decision: <point>=<outcome> (<reason>; <inputs>) [build=…]`.
 *
 * The exact `[glasstrace]` prefix (closing bracket included) routes the
 * line past console-capture; the `decision:` discriminator follows the
 * closing bracket so the guard still matches. The `(<reason>; <inputs>)`
 * group and the `[...]` correlation suffix are each omitted when empty.
 */
function formatLine(
  point: string,
  outcome: string,
  reason: string | undefined,
  inputs: Record<string, string | number | boolean> | undefined,
): string {
  let line = `[glasstrace] decision: ${point}=${outcome}`;

  const inner = renderInner(reason, inputs);
  if (inner.length > 0) {
    line += ` (${inner})`;
  }

  const suffix = renderCorrelation();
  if (suffix.length > 0) {
    line += ` ${suffix}`;
  }

  return line;
}

/** Render the `<reason>; <inputs>` inner group; empty string when both absent. */
function renderInner(
  reason: string | undefined,
  inputs: Record<string, string | number | boolean> | undefined,
): string {
  const parts: string[] = [];
  if (reason !== undefined) parts.push(reason);
  if (inputs !== undefined) {
    const rendered = Object.keys(inputs)
      .map((k) => `${k}=${String(inputs[k])}`)
      .join(",");
    if (rendered.length > 0) parts.push(rendered);
  }
  return parts.join("; ");
}

/**
 * Render the optional `[build=…]` correlation suffix, or the empty string
 * when no build hash is present (the suffix never blocks emission on a
 * missing correlation value).
 *
 * Only the build token is stamped: a session id is deliberately not
 * threaded into the emitter, since that would couple every hot-path gate
 * to the api key. The bracket group is present only when a SHA-shaped
 * build hash is available, and absent otherwise. The SHA-shape gate
 * (via `getCorrelationBuildHash()`) ensures a misconfigured
 * `GLASSTRACE_BUILD_HASH` holding a non-SHA secret is never echoed into
 * the decision line, upholding the emitter's no-secret guarantee.
 */
function renderCorrelation(): string {
  const tokens: string[] = [];
  const build = getCorrelationBuildHash();
  if (build !== undefined && build.length > 0) {
    tokens.push(`build=${build.slice(0, _BUILD_HASH_PREFIX_LEN)}`);
  }
  return tokens.length > 0 ? `[${tokens.join(" ")}]` : "";
}

/**
 * Test-only reset for the decision-trace toggle and dedup state. Not
 * exposed from the public package barrel. Tests must call this between
 * describe blocks so the toggle and one-shot state do not leak.
 *
 * @internal
 */
export function _resetDecisionTraceForTesting(): void {
  _flag = null;
  _seenKeys.clear();
}
