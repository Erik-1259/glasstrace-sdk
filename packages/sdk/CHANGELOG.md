# @glasstrace/sdk

## 1.25.0

### Minor Changes

- 9dad60c: Wire the remaining config and capture decisions into the decision-trace toggle

  Decision tracing now instruments the SDK's previously-silent config and capture
  gates, so an operator or validator can see exactly which gate closed when capture
  produces nothing. The following decision points are added behind the existing
  `decisionTrace` / `GLASSTRACE_DECISION_TRACE` toggle (which still defaults off):

  - `capture.fidelity.idModel`, `capture.fidelity.identifier`, and
    `capture.fidelity.hmacKey` — the identifier-capture path in the Prisma adapter:
    whether the account is on full fidelity, whether the value was hashed, and
    whether the per-account hashing key is provisioned.
  - `config.tier` — which fallback tier served the active capture config
    (`served`, `cached`, or `default`).
  - `sideEffect.fieldRejected` — a side-effect field or scalar was dropped, keyed by
    the closed omission reason only (never the field key or rejected value).
  - `feature.consoleErrors`, `feature.errorResponseBodies`, and `feature.discovery`
    — whether each optional capture feature is enabled.
  - `otel.path` — the OpenTelemetry provider path the SDK took (bare registration,
    the `@vercel/otel` path, or a coexistence outcome).
  - `env.forceEnable` — how the production gate resolved: `production_disabled`,
    `forced` (force-enable actually overrode a detected production env), or
    `normal` (not a production env, so force-enable was a no-op).
  - `env.nudgeSuppressed` and `env.upgradeNoticeSuppressed` — whether the one-time
    MCP-connection nudge and the stale-instruction upgrade notice were shown or
    suppressed.

  Most points respond to both the programmatic option and the env var.
  `env.upgradeNoticeSuppressed` is an early-bootstrap point that decides before the
  SDK threads the resolved decision-trace flag, so it is observable only via the
  `GLASSTRACE_DECISION_TRACE` environment variable.

  The change is strictly additive and behavior-neutral: every site is guarded so no
  detail object is built while the toggle is off, no branch outcome ever changes, and
  each point's outcome and one-shot dedup key come from a small closed, code-literal
  vocabulary so no point can echo producer input, raw values, or secrets, or exhaust
  the bounded dedup cap.

- a1f4721: Teach installed agent guidance that a sparse trace candidate is not absence of evidence

  The managed Glasstrace MCP section the SDK writes into agent instruction files now
  tells the agent that a `find_trace_candidates` candidate whose compact summaries are
  absent is still evidence: the compact category projections (`performanceQuerySummary`,
  `dataShapeSummary`, `raceConcurrencySummary`, `contextBranchSummary`) appear only on
  the top-ranked candidate within a small inline budget, and a `sideEffectEvidence` that
  is absent or has status `missing`/`withheld`/`unsupported` is not proof there was no
  side effect — in each case the agent should pull the trace via `get_trace` /
  `get_root_cause`. It also guides the agent to broaden or retry a sparse or ambiguous
  search by procedure (`find_trace_candidates({ procedure: "<name>" })`, preferred over a vague
  route fragment), and to compare the candidate's matched route against the URL it
  searched before concluding a code path never ran.

## 1.24.0

### Minor Changes

- 5d14264: Teach the installed agent guidance to use returned MCP trace evidence

  The managed Glasstrace MCP section the SDK writes into agent instruction files
  now teaches agents how to act on what the tools return, not just which tool to
  call first. It frames side-effect evidence as first-class runtime evidence — the
  compact presence on `find_trace_candidates` candidates versus the per-operation
  values on `get_latest_error` / `get_trace` / `get_root_cause` — explains that
  boolean relation fields (keys ending in `Holds`) are direct true/false claims and
  that categorical fields (`templateKey`, `providerOperation`, operation `status` /
  `phase`) identify which operation ran and what state it reached, and clarifies
  that a thin follow-up does not invalidate evidence already in hand: an empty
  `get_span_attributes` result means only that no scalar drill-down was returned,
  and an unavailable `get_root_cause` still ships a usable trace summary to continue
  from. It also guides agents to inspect the smallest source path the trace names
  before broad exploration, to compare multiple traces in sequence for stateful
  bugs, and to cross-check trace facts against source and direct verification. The
  `get_span_attributes` drill-down tool is now named in the tools list.

## 1.23.1

### Patch Changes

- 5f859bb: docs: document the prismaAdapter passive value-capture extension and the producer/operator allowlist contract

  Adds a README section for `prismaAdapter({ allow })` — the passive Prisma client
  extension that projects allowlisted result columns onto the value-fidelity
  scalar channel. Covers the `as`-intent suffixes, the `as: "id"` pseudonymized
  `gthid_` behavior (full fidelity + provisioned key), the two-allowlist
  (producer `allow` + operator server allowlist) contract keyed on the emitted
  scalar key, the no-doubling suffix derivation, the result-shape requirement, and
  the fail-closed behavior for each misconfiguration.

## 1.23.0

### Minor Changes

- 7a2ceec: Detect boundary-masked Next.js errors that surface on a descendant render span

  The boundary-masked-error heuristic previously fired only when the HTTP
  request span itself carried the error signal. It now also detects the
  page-route boundary case, where the request renders an HTTP 200 while a
  transitive child span (for example a Next.js render-route span) records the
  exception. When this case is detected, the SDK promotes the stored
  `glasstrace.http.status_code` to 500 and records the new
  `glasstrace.http.boundary_masked_scope` discriminator (`same_span` or
  `descendant`) alongside the existing `glasstrace.http.boundary_masked`
  attribute, so consumers can tell which scope produced the promotion.

  Descendant detection is fenced against false positives: it requires an
  exception event (not merely an error-status child), excludes framework
  control-flow throws, leaves expected `error.tsx` fallbacks over a generic
  application error at 200, and promotes render-route descendants only for
  unexpected infrastructure failure classes (currently database/driver errors
  such as a database-unreachable failure; the list grows additively). A
  boundary can opt out per request with a
  `glasstrace.error.expected` span attribute.

  The `core:error_boundary_detected` lifecycle event now carries a `source`
  discriminator (`same_span` | `descendant`) on both paths and, for the
  descendant path, an `exceptionSpanId` identifying the descendant span. The
  OpenTelemetry `http.status_code` is left at its original value; only the
  Glasstrace status reflects the inferred failure, and the browser response
  is unchanged.

  Adds the `GLASSTRACE_DISABLE_BOUNDARY_MASKED` environment flag (truthy `1`
  or `true`) to disable boundary-masked promotion entirely for both scopes.

## 1.22.3

### Patch Changes

- 6b8c456: fix: share the per-account hashing key across bundled module instances

  Under bundled development runtimes (Next.js / Turbopack `next dev`), the SDK can be
  evaluated as more than one module copy in a single process. The per-account hashing
  key used for full-fidelity pseudonymized `*Id` capture was held in module-local
  state, so a copy that ran a Prisma projection without having applied the served
  config could not read it — and full-fidelity `*Id` capture silently produced no
  token.

  The key now lives on the shared, process-global active-config record, behind a
  closure accessor that keeps the raw bytes off the record's enumerable surface (so it
  never appears in a serialized dump), reachable by every module copy. This is a
  deliberate, scoped reduction of the key's previous in-isolate confinement —
  appropriate for a development-time SDK, where the key is already in process memory —
  and is required for full-fidelity `*Id` capture to work in bundled dev runtimes. The
  single shared key follows last-writer-wins semantics, so no module copy can hash with
  a stale or wrong-tenant key.

## 1.22.2

### Patch Changes

- f8dfe01: Share the resolved capture-config across bundled module instances

  Under Turbopack `next dev` (HMR rebuilds) and the edge-vs-node bundle
  split, the bundler can evaluate more than one copy of the SDK's config
  module in a single process. The resolved active capture-config was held in
  plain module-level state, so the copy that the background init applied (the
  served config, e.g. side-effect evidence enabled) was not necessarily the
  copy the in-request emitter read at the call site. The reader fell through
  to the fail-closed default and silently captured nothing despite the
  backend serving capture as enabled.

  The resolved config and its once-per-process disk-cache-checked flag now
  live in a `globalThis` singleton keyed on a process-global symbol, so every
  bundle instance reads and writes the same record. The per-account HMAC
  secret is split off into module-local state and is never placed on that
  shared record, so it stays off the well-known global slot and keeps the
  same confinement it had before; the public getter still returns the config
  with the secret redacted. A non-secret pairing token on the shared record
  ties each instance's local key to the config it came from, so if a later
  apply (key rotation, a different tenant, any subsequent init) supersedes
  it, the now-stale key is no longer returned and full-fidelity id
  pseudonymization fail-closes instead of hashing with the wrong key. A
  reader instance that sees a `full`, key-provisioned posture but has no
  local key behaves like strict (skips identifier projection) rather than
  emitting a spurious unhashed-id omission; a genuinely key-less `full`
  account still records that omission so the misconfiguration stays
  observable. The read-fresh-each-call rotation semantics and the existing
  setter are unchanged; the only behavioral difference is that an applied
  capture config is now visible across bundle copies. The store touches no
  Node built-in and never reaches the `process` global, so it stays inside
  the edge-safe runtime contract.

## 1.22.1

### Patch Changes

- b0d6f64: Remove internal tracking references from agent-detection JSDoc

  Two JSDoc blocks describing the agent-instruction recovery contract
  carried internal tracking identifiers and an internal repository name.
  The sentences are reworded in plain, public language while preserving the
  technical meaning — the load-bearing recovery contract codified in the
  server-side MCP `ToolDiagnosticSchema` / `CandidateDiagnosticSchema`
  schemas, and the bail-to-source failure mode the prior cost-aware decision
  paragraph did not surface. No public API, type signature, or runtime
  behavior changes — documentation text only.

## 1.22.0

### Minor Changes

- 53d7ddd: Make config capture/emit/redact decisions observable via a decision-trace toggle

  The SDK makes many of its capture, emit, and redact decisions silently:
  when capture produces nothing, it is hard to tell which config gate closed.
  This adds an opt-in decision trace, off by default, that emits one
  greppable `[glasstrace] decision:` line — and a `core:decision` in-process
  lifecycle event for the load-bearing gates — at each instrumented decision
  point.

  - New toggle: the `decisionTrace` option and the `GLASSTRACE_DECISION_TRACE`
    environment variable, both defaulting off. `verbose: true` turns it on as
    well, so existing verbose sessions get decision lines for free.
  - The same decisions are mirrored to a `core:decision` event on the SDK's
    internal lifecycle bus, which the SDK's own integration tests assert on.
    This bus is not part of the public API; the greppable console line is the
    supported way to consume decision traces.
  - Two priority gates are instrumented in this release: the `recordSideEffect`
    capture-disabled branch, and the config-apply outcome at init (the
    backend-authoritative `sideEffectEvidence` / `captureFidelity` the SDK
    applied; on init failure it reports the still-active cached posture, or a
    distinct fail-closed line when no cached config keeps capture enabled).

  Strictly additive and behavior-neutral: capture behavior is byte-for-byte
  identical whether the toggle is on or off, the emitter never throws into the
  caller, and it is a strict no-op (no hot-path allocation) when off. It emits
  flags and enums only — never request/response bodies, never a rejected key
  or value, and never a secret (keys are masked; key-shaped config values are
  reported only as present/absent).

## 1.21.1

### Patch Changes

- 835f830: Only infer boundary-masked error status on HTTP server spans

  The status promotion that surfaces errors masked behind a `200` response
  previously gated on the presence of `http.method` but not on span kind. OTel
  client spans (a failed outbound `fetch`, a DB-over-HTTP call, or the SDK's own
  OTLP export `POST`) also carry `http.method`, and a failed outbound request
  typically has an exception event / `ERROR` status with no or `200` status — so
  it was wrongly promoted to a `500` and tagged `glasstrace.http.boundary_masked`,
  which could appear as a spurious error trace. The heuristic is now restricted to
  server spans, mirroring the existing span-kind gate on the fetch-target
  classifier. No public API surface changes.

## 1.21.0

### Minor Changes

- dc91d6e: Make categorical side-effect evidence robust to a missing active span

  `recordSideEffect` now accepts an optional owned span —
  `recordSideEffect(input, { span })` — that attaches the operation to a span you
  control instead of the ambient active OTel span, mirroring the `capture()`
  value-fidelity primitive. Use it when the host app's OTel context may not
  survive intact to the call site (categorical evidence otherwise drops silently
  when no span is recording). A supplied span that has ended or is a
  `NonRecordingSpan` is a silent no-op and does not fall back to the ambient span.

  When no recording span is available, the SDK now also emits a one-time
  diagnostic under `verbose` — instead of dropping the evidence with no signal —
  pointing at the fix (`tracedMiddleware`, or passing an owned span).

## 1.20.0

### Minor Changes

- 334c399: Capture allowlisted identifier columns as pseudonymized tokens

  The Prisma adapter gains an `as: "id"` intent that projects an identifier
  column onto an `*Id` value-fidelity scalar as a stable, opaque `gthid_<hex>`
  token — the raw id is hashed under a per-account key (delivered via the new
  optional `attrHmacKey` capture-config field) and never reaches the wire.
  Identifier capture is operator-gated: it activates only under full-fidelity
  capture with a provisioned key. A full account missing the key records a
  count-only `unhashed_id` omission so the misconfiguration stays visible. The
  token is computed with Web Crypto (`globalThis.crypto.subtle`) rather than
  `node:crypto`, so the identifier path adds no new Node-builtin dependency to
  the root barrel.

## 1.19.0

### Minor Changes

- 97cd7d9: `prismaAdapter` now captures numeric columns, not just booleans. Each allow entry takes an optional `as` intent — `"flag"` (default, boolean) or `"value"` / `"amount"` / `"ms"` / `"bytes"` / `"ratio"` (finite number) — that appends the value-fidelity scalar key suffix to the column, not doubled if the column already ends in it (e.g. `{ column: "size", as: "bytes" }` projects `sizeBytes`). Values are strict-validated by type at emit and gated by your account's capture allowlist. Numeric intents capture native JavaScript `number` columns only — a Prisma `Decimal` (a Decimal.js object) or `BigInt` is safely omitted rather than lossily converted. `as` defaults to `"flag"`, so existing configurations are unchanged.

## 1.18.1

### Patch Changes

- f8249c5: Clarify the `prismaAdapter` owned-span documentation: the captured `db.<Model>.<op>` span is described as a same-trace descendant of the request span (its immediate parent is the active span, which on some Prisma / instrumentation versions is the still-recording database operation span) rather than always a direct child of the request span. Documentation-only — no public API or runtime behavior change.

## 1.18.0

### Minor Changes

- 7579ea1: Add passive Prisma value capture. `prismaAdapter({ allow })` is a Prisma client extension that records allowlisted boolean result columns onto your traces (for an eligible operation it opens a single `db.<Model>.<op>` span and emits a `*Flag` scalar for each allowlisted column), so an agent debugging a failure can see the value a query returned. It is passive and default-deny: it never alters a query or its result, captures nothing without an explicit `allow` entry, skips `findMany`/list queries, and has no `@prisma/client` dependency. The lower-level `capture(name, value, { span })` primitive projects a single allowlisted scalar onto a span you own, for building custom adapters. Both are gated by your account's capture configuration and never throw.

## 1.17.0

### Minor Changes

- 97115ae: Capture boolean `*Holds` relations on side-effect evidence.

  `recordSideEffect()` now accepts an optional `relations` map of
  `boolean`s — producer-asserted invariants emitted on the categorical
  field channel. Keys end in `Holds` (e.g. `timezonePreservedHolds`);
  values are coerced to `"true"`/`"false"`. A non-`Holds` key, a
  non-boolean value, or a key that also appears in `fields` (a collision —
  `fields` wins) is dropped with the matching omission counter.

  Two pure helpers compute the boolean from a comparison:

  ```ts
  import {
    recordSideEffect,
    invariant,
    isNullInvariant,
  } from "@glasstrace/sdk";

  recordSideEffect({
    kind: "calendar_link",
    operation: "invite.create",
    relations: {
      durationMatchesHolds: invariant(emittedMinutes, "eq", declaredMinutes),
      recipientMissingHolds: isNullInvariant(recipient),
    },
  });
  ```

  `invariant(left, op, right)` supports `eq` / `neq` / `lt` / `lte` / `gt`
  / `gte`; `isNullInvariant(value)` is the unary null/undefined check. Both
  are edge-safe. Existing `recordSideEffect()` calls are unaffected.

  The SDK emits `*Holds` relations now; the Glasstrace backend admits them
  in a coordinated follow-up release. Until then a `*Holds` field is dropped
  at ingestion and is not yet surfaced in traces.

## 1.16.0

### Minor Changes

- 76c447a: Capture type-aware value-fidelity scalars on side-effect evidence.

  `recordSideEffect()` now accepts an optional `scalars` map for native
  type-aware magnitudes emitted on the off-summary
  `glasstrace.side_effect.scalar.*` channel — the key suffix declares the
  type (`Ms` / `Amount` / `Bytes` / `Ratio` / `Value` → finite number,
  `Flag` → boolean, `Id` → a pseudonymized `gthid_` string). Values are
  validated at emit time under a fail-closed `strict` posture: raw
  wall-clock timestamps (a `Date`, or a raw epoch on a `*Ms` key) and
  unhashed `*Id` values are rejected and never reach the wire, surfacing
  only as integer omission counts. Send bounded deltas as numbers, and
  pre-hash identifiers with the new `hashId` helper:

  ```ts
  import { recordSideEffect } from "@glasstrace/sdk";
  import { hashId } from "@glasstrace/sdk/node";

  recordSideEffect({
    kind: "external_api",
    operation: "charge.create",
    scalars: {
      latencyMs: 142,
      retriedFlag: false,
      customerId: hashId(rawCustomerId, process.env.GLASSTRACE_ATTR_HMAC_KEY!),
    },
  });
  ```

  `hashId` (HMAC-SHA256, fixed-shape `gthid_<hex>`, fail-closed) ships on
  the Node-only `@glasstrace/sdk/node` subpath. A `captureFidelity` posture
  is added to the capture-config contract (default `strict`); scalar
  emission is validated as `strict` in this release. Existing
  `recordSideEffect()` calls are unaffected.

## 1.15.1

### Patch Changes

- 5f12903: Surface a verbose-mode diagnostic when Prisma instrumentation is skipped

  When `@prisma/instrumentation` cannot be resolved at startup, the SDK
  previously skipped Prisma span registration silently, leaving developers
  with missing database spans and no explanation. The SDK now logs a
  diagnostic in verbose mode (`registerGlasstrace({ verbose: true })`) on
  both the Vercel and bare OpenTelemetry paths — including when
  instrumentation initialization throws — explaining that Prisma query
  spans will not be captured and how to resolve it.

  The README gains a "Database query spans (Prisma)" section documenting the
  most common cause (package managers such as pnpm not exposing transitive
  copies of optional peers) and the fix: add `@prisma/instrumentation` as a
  direct dependency. There is no behavior change when Prisma is present, and
  the diagnostic stays silent unless verbose mode is enabled.

## 1.15.0

### Minor Changes

- cde27c0: Clarify first-call decision guidance in SDK-installed agent instructions

  Restructure the Workflow §1 in the SDK-managed agent-instruction section
  into an explicit three-way decision tree keyed on symptom class:

  - **Active failure** (stack trace, recent error, request that just failed)
    → `get_latest_error` first.
  - **Known route or procedure with suspected misbehavior** →
    `find_trace_candidates` with a tight time window.
  - **Historical exploration** (no recent failure, checking whether a code
    path ever ran) → `find_trace_candidates` with an open window.

  The prior wording started every workflow with `find_trace_candidates`
  regardless of symptom; in production traffic this caused agents to skip
  `get_latest_error` even when an active failure made it the cheapest and
  most decisive first call.

  The SDK-050 cost-aware framing ("Call Glasstrace FIRST when" / "SKIP
  Glasstrace when") is preserved unchanged alongside the new decision
  tree, so the agent has both the symptom-class router (which tool first)
  and the cost-vs-skip guidance (whether to call at all). Existing
  installations re-render on the next `glasstrace dev` invocation; no
  manual migration needed.

## 1.14.0

### Minor Changes

- c2014e5: Side-effect vocabulary-governance signals

  - Emit a `console.warn` the first time a `*Class` or `*Role` field value
    deviates from the lowercase-kebab convention (dedup by `(key,
casing-pattern)` per process; warn message contains the key name only
    for PII safety). Emission still succeeds — the warn is a producer-side
    normalization signal, not enforcement.

  - When the SDK is initialized with `verbose: true`, emit a one-shot
    `console.warn` when a process has emitted 50 distinct pattern-admitted
    field keys (those without an explicit attribute mapping — stable-core
    and the existing built-in keys do not count). The warn lists the
    most-recent 5 keys and recommends vocabulary review. Default behavior
    (verbose off) is unchanged.

  Both signals are non-blocking and emit at most once per (key,
  casing-pattern) or once per process respectively.

## 1.13.0

### Minor Changes

- 6a749c1: Replace the closed `SIDE_EFFECT_SEMANTIC_FIELD_KEYS` allowlist with
  named-pattern admission for `recordSideEffect()` semantic fields.

  **Stable core** (7 keys, unchanged shapes): `templateKey`,
  `providerOperation`, `role`, `locale`, `timezone`, `status`, `phase`.
  `locale` and `timezone` keep their specialized BCP-47 / IANA
  validators; the other five use the identifier-shaped compact-token
  validator.

  **Open pattern** (new): any key matching
  `^[a-z][A-Za-z0-9]*(Class|Count|Kind|Role)$` is admitted alongside
  the stable core. Value validators route on the suffix —
  `*Count` keys use a digit-only validator with a tighter 16-character
  length cap; `*Class` / `*Kind` / `*Role` keys use the existing
  compact-token validator with the standard 80-character cap.

  **Public API additions** — mirrors the existing pattern where tuples
  and regex constants live in `@glasstrace/protocol` and the SDK barrel
  re-exports the types and runtime helpers consumers most often reach
  for.

  Added to `@glasstrace/protocol`:

  - `SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS` — closed 7-entry tuple
    for the stable core.
  - `SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN` — the canonical regex,
    exported so consumers can reference it directly.
  - `MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH` — explicit 80-char cap
    on semantic field key names. Part of the admission contract: the
    pattern regex has no length bound on its own, so a producer that
    derived a key from request/provider metadata could otherwise pass
    an arbitrarily long string ending in a canonical suffix.
  - `isSideEffectSemanticFieldKey(key: string): boolean` — runtime guard
    for the admission contract. Returns `true` when `key` is non-empty,
    no longer than `MAX_SIDE_EFFECT_SEMANTIC_FIELD_KEY_LENGTH`, and
    either stable-core or pattern-matching.
  - `SideEffectSemanticFieldStableCoreKey` — narrower compile-time type
    for the stable-core subset. Use this if you want autocomplete on the
    7 stable-core literals.

  Re-exported from `@glasstrace/sdk`:

  - `isSideEffectSemanticFieldKey` (runtime).
  - `SideEffectSemanticFieldStableCoreKey` (type).

  The tuple `SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS` and the regex
  constant `SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN` are not re-exported
  from the SDK barrel — import them from `@glasstrace/protocol`
  directly. This matches how the other side-effect tuples
  (`SIDE_EFFECT_OPERATION_KINDS`, etc.) are already published.

  **Public API removal** (`@glasstrace/protocol`):

  - `SIDE_EFFECT_SEMANTIC_FIELD_KEYS` — the closed 10-entry tuple is
    removed. Consumers that imported this array should switch to
    `SIDE_EFFECT_SEMANTIC_FIELD_STABLE_CORE_KEYS` (7 entries) plus the
    runtime guard `isSideEffectSemanticFieldKey()` for full admission
    checking. Defensible under pre-1.0 semver — `@glasstrace/protocol`
    remains in the `0.x` range — but the removal is intentional and
    not a stealth break.

  `SideEffectSemanticFieldKey` widens from a closed-literal union to
  `stable-core | string`. TypeScript collapses this to `string` at the
  type level (the `string` arm subsumes the literal arm), so
  compile-time narrowing for arbitrary pattern keys is intentionally
  relaxed at this surface. Use `isSideEffectSemanticFieldKey()` for
  runtime validation; import `SideEffectSemanticFieldStableCoreKey` for
  compile-time autocomplete on the closed subset.

  The three keys added in the previous release — `recipientClass`,
  `participantCount`, `activeParticipantCount` — keep their existing
  explicit `GLASSTRACE_ATTRIBUTE_NAMES` constants for backward
  compatibility (`SIDE_EFFECT_FIELD_RECIPIENT_CLASS`,
  `SIDE_EFFECT_FIELD_PARTICIPANT_COUNT`,
  `SIDE_EFFECT_FIELD_ACTIVE_PARTICIPANT_COUNT`). New pattern-admitted
  keys do NOT get per-key constants; their OTel attribute name is
  derived at emission as `glasstrace.side_effect.field.<key>`.

## 1.12.0

### Minor Changes

- 163e2da: Extend the side-effect semantic field allowlist with three additive keys:
  `recipientClass`, `participantCount`, and `activeParticipantCount`.

  The keys let callers of `recordSideEffect()` record concise causal evidence
  about which recipient class a side-effect targeted and how many domain
  entities were included. `recipientClass` uses the existing compact-token
  validator (identifier-shaped: alphanumeric with `_.:-`). `participantCount`
  and `activeParticipantCount` use a stricter digit-only validator so
  misleading non-digit values (`"many"`, `"a few"`, `"1:2"`, `"1.5"`) are
  rejected as `raw_payload` rather than recorded as causal evidence.

  Counts must be encoded as non-negative integer strings. Case is preserved
  verbatim on the wire for `recipientClass`, so producers should normalize
  labels at the call site (lowercase-kebab is the recommended convention).

  The change is fully additive: the existing seven semantic field keys
  (`templateKey`, `providerOperation`, `role`, `locale`, `timezone`,
  `status`, `phase`) and their wire shapes are unchanged. Three new
  `GLASSTRACE_ATTRIBUTE_NAMES` constants ship alongside the keys:
  `SIDE_EFFECT_FIELD_RECIPIENT_CLASS`,
  `SIDE_EFFECT_FIELD_PARTICIPANT_COUNT`, and
  `SIDE_EFFECT_FIELD_ACTIVE_PARTICIPANT_COUNT`, each emitting under the
  `glasstrace.side_effect.field.<camelCase>` attribute namespace.

## 1.11.0

### Minor Changes

- 14cd1ca: Wave 18: align agent-instruction injection with the 2026 cross-tool
  file-convention standard governed by the Agentic AI Foundation under
  the Linux Foundation.

  The SDK now writes the Glasstrace MCP managed section to:

  - `AGENTS.md` (universal cross-tool destination — read by Cursor,
    Codex, Claude Code, GitHub Copilot, Devin, Windsurf, Gemini CLI)
  - `CLAUDE.md` (Claude Code primary, unchanged)
  - `GEMINI.md` (Gemini CLI primary — was previously not written at all)
  - `.cursor/rules/glasstrace.mdc` (Cursor canonical 2026 `.mdc`
    workspace-rules destination with `alwaysApply: true` frontmatter)
  - `.cursorrules` (Cursor transitional fallback — written
    unconditionally for mixed-version Cursor migration safety)
  - `.windsurf/rules/glasstrace.md` (Windsurf workspace-rules directory)

  Legacy single-file destinations (`codex.md`, `.windsurfrules`) are
  no longer written to as primary — Codex no longer reads `codex.md`
  by default and Windsurf has migrated away from `.windsurfrules`. The
  legacy files are left untouched (their managed sections become stale
  but free-text content is preserved); run
  `npx glasstrace upgrade-instructions` to migrate.

  The path-exists gate in `detect.ts` was dropped — the SDK now
  creates canonical files when missing under the DISC-1592 marker
  contract (idempotent in-place replacement on re-runs preserves the
  soaked-in-production semantics). Multi-target write failures are
  handled per-target with a fail-loud-per-target stderr warning (the
  existing per-target write contract is broadened to all error
  classes: EACCES, EROFS, ENOSPC, ENAMETOOLONG, ENOTDIR, EIO).

  Backward-compat: existing users on legacy files retain access; the
  legacy files are not deleted; the stale-section warning at SDK init
  points the user at `npx glasstrace upgrade-instructions` for
  migration. The `DetectedAgent` exported interface is unchanged
  (option (c) sibling-helper design preserves the public API surface).

## 1.10.2

### Patch Changes

- 39518ff: feat(sdk): expand Workflow §4 of the agent-instruction body to name the new `windowActivity` / `humanReadable` / `diagnosticValue` / `recommendedNextStep` empty-result envelope fields

  Wave 17 follow-up. The vocabulary-mismatch-recovery wave that
  landed on the server side (closing DISC-1626 + 40 sibling DISCs)
  added five fields to the no-match envelope on
  `find_trace_candidates`'s `CandidateDiagnosticSchema` and the
  sibling-tools' `ToolDiagnosticSchema`: `windowActivity`,
  `humanReadable`, `diagnosticValue`, `recommendedNextStep`, and
  `maxUsefulFollowups`. The Wave 17 SDK-injected agent-instruction
  body shipped before those fields landed, so its Workflow §4 named
  only `closeMatches` / `recentRoutesSample` / `recoveryActions`.

  This release expands Workflow §4 to name each of the new fields
  with a one-line gloss on what each one disambiguates. Most
  importantly, `windowActivity` is now described as the load-bearing
  four-way distinguisher between "wrong vocabulary", "no traffic in
  window", "captureConfig-blocked", and "no traces ever for this
  tenant" branches — without `windowActivity` the agent cannot tell
  a vocabulary miss apart from "the SDK was never registered for
  this tenant", because the two look identical at the
  `closeMatches`-only layer.

  Existing users on stale SDKs continue to see the prior content in
  their agent instruction files until they run
  `npx glasstrace upgrade-instructions` (or
  `npx glasstrace mcp add` against the same target) — the explicit
  DISC-1592 upgrade-refresh contract. (`glasstrace` is the SDK's
  published CLI bin name, per `packages/sdk/package.json`.)

  The DISC-1592 / DISC-1602 marker contract is preserved intact;
  this is content-only, no public API surface change. **Patch bump.**

## 1.10.1

### Patch Changes

- a01e9bd: feat(sdk): replace agent-instruction body with explicit FIRST/SKIP decision rules; align cursor + windsurf MCP config with canonical http shape

  The text the SDK injects into `CLAUDE.md` / `.cursorrules` / `codex.md`
  between the `<!-- glasstrace:mcp:start v=... -->` markers now opens with
  explicit "Call Glasstrace FIRST when:" / "SKIP Glasstrace when:"
  decision rules so a frontier coding agent has a cheap pre-tool-call
  heuristic before spending tokens on tool consideration. The Workflow
  section names `find_trace_candidates` as the discovery entry point
  and instructs the agent to read `closeMatches`, `recentRoutesSample`,
  and `recoveryActions` before pivoting to source — preventing the
  bail-to-source failure mode after an empty MCP result. The body is
  sourced from a new internal sibling module
  (`agent-instruction-text.ts`) so future content edits are isolated
  from the surrounding marker / version-stamp / per-agent-format
  machinery in `configs.ts`.

  The body deliberately does NOT inline the endpoint URL — agents
  reach Glasstrace via the MCP server name `glasstrace` configured in
  `.glasstrace/mcp.json` or per-agent native config, not by reading a
  URL out of the instruction file. Keeping the URL out of the
  instruction text avoids drift between the instruction file and the
  MCP config and keeps the body tight.

  Bundled config-shape fixes:

  - Cursor MCP config now emits the canonical
    `{ type: "http", url, headers }` shape (the prior shape omitted
    `type`).
  - Windsurf MCP config now emits `url` (not the prior `serverUrl`)
    and includes `type: "http"`.

  Both align with the Claude-compatible HTTP shape the generic branch
  already used. Apps that previously consumed the cursor or windsurf
  config in the prior shapes will pick up the new shape on next
  `npx glasstrace mcp add` / `npx glasstrace init` run.

  Existing users on stale SDKs continue to see the prior content in
  their agent instruction files until they run
  `npx glasstrace upgrade-instructions` (or `npx glasstrace mcp add`
  against the same target). This is the explicit DISC-1592
  upgrade-refresh contract — body and stamp refresh together when the
  user opts in via the upgrade command.

  The marker contract from SDK-050 / DISC-1592 / DISC-1602 is preserved
  intact: `<!-- glasstrace:mcp:start v=<sdkVersion> -->` start marker,
  unstamped end marker, idempotent in-place replacement on re-render,
  stale-stamp warning at SDK init.

  **Patch bump.** Content/config evolution only — no public API surface
  change, no exported function signature changes.

## 1.10.0

### Minor Changes

- ed7d6e9: feat(sdk): boundary-masked-error audit attribute + lifecycle event (SDK-051)

  Adds observability for the SDK's existing same-span boundary-masked-error
  heuristic (the DISC-1134 status-inference path at
  `enriching-exporter.ts`):

  - New wire attribute `glasstrace.http.boundary_masked: true` is set on
    HTTP server spans where the SDK promotes an inferred `status_code`
    because an error signal (any of: `span.status === ERROR`, an
    `exception` event, or `exception.*` attributes) was present
    alongside a trigger-set status (`{200, 0, undefined}`). Strict
    additivity — backend ignores unknown attributes today, so this is
    for downstream observability of heuristic activation rate.
  - New lifecycle event `core:error_boundary_detected` fires once per
    promotion with `{ spanId, inferredStatus, exceptionMessage? }`.
    Subscribers MAY consume this for activation-rate dashboards; the
    heuristic's behavior does NOT depend on subscribers. Exception
    messages are truncated to 256 chars in the payload and omitted
    entirely when neither an exception event nor `exception.message`
    attribute was present.

  **Same-span scope only.** This release covers the case where the HTTP
  server span itself carries the error signal. Page-route boundary
  detection where the exception lives in a child span requires
  descendant-traversal in the exporter and is tracked in a follow-up
  DISC. DISC-1125 stays PARTIAL after this release.

  Patch bump for `@glasstrace/protocol` (new constant; strict
  additivity).

- 691071e: feat(sdk): tRPC batch member span emission via wrapBatchedHttpHandler (SDK-052)

  Adds opt-in per-member span attribution for batched tRPC HTTP
  requests. Apps that wrap their tRPC HTTP handler with the new
  `wrapBatchedHttpHandler` AND use `tracedMiddleware` get a
  `glasstrace.trpc.batch.member_index` (number) and
  `glasstrace.trpc.batch.member_procedures` (OTel typed string array)
  attribute on each member span, so per-member attribution is
  preserved when tRPC's HTTP-batch link bundles multiple procedures
  into a single HTTP request.

  **Public API additions:**

  - `wrapBatchedHttpHandler<H>(handler, options?: { basePath?: string })`
    exported from `@glasstrace/sdk/trpc`. Apps wrap their tRPC HTTP
    handler (Next.js app-router route, Express endpoint, etc.) once
    at the boundary; the wrapper inspects each request's URL and
    sets a request-scoped `AsyncLocalStorage` envelope when the URL
    matches the batch pattern at the configured base path.
    Default `basePath` is `/api/trpc/`; apps that mount tRPC at a
    different path pass their actual base path explicitly (per
    DISC-1215, the tRPC base path is configurable on the user side).

  **Wire format additions (strict additivity):**

  - `glasstrace.trpc.batch.member_index` — zero-based positional
    index of each member in the batch. Load-bearing for batches that
    include the same procedure name more than once (positional
    matching, NOT name-only matching).
  - `glasstrace.trpc.batch.member_procedures` — OTel typed string
    array (`string[]`) listing all member procedure names in the
    batch order.

  **Lifecycle event addition:**

  - `otel:trpc_batch_member_mismatch` fires when `tracedMiddleware`
    runs under an envelope but the procedure name doesn't match any
    positional member (the failure mode that preserves trace shape).
    Informational; subscribers MAY consume it for observability.

  **Cross-version compatibility:** works with `@trpc/server@^10` and
  `@trpc/server@^11`. The envelope is propagated via Node
  `AsyncLocalStorage` rather than tRPC's `createContext` shape
  (which differs between major versions).

  **Out of scope (DISC-1534 stays PARTIAL after this release):**

  - Product backend ingestion storage of per-member span hierarchy —
    separate product-side wave.
  - MCP query projection of per-member duration / status / DB
    attribution — separate product-side wave.
  - Auto-attach integration (wrapping tRPC handlers automatically) —
    v1 is opt-in; a future brief may add auto-detection.
  - Root HTTP server span shape — the existing comma-joined
    `glasstrace.trpc.procedure` attribute is unchanged. The brief
    proposed reshaping it to a first-member representative + array,
    but that is non-additive and is deferred to a separate wave.

  Apps not using `wrapBatchedHttpHandler`, and apps not using
  `tracedMiddleware`, see no trace-shape change.

  Patch bump for `@glasstrace/protocol` (new constants; strict
  additivity).

## 1.9.1

### Patch Changes

- 4231611: fix(sdk): wave-15b instrumentation hardening — defensive try/catch around
  tracer calls; path-attribute privacy documentation; regression tests for
  the sampler-drop and span-activation review fixes (Wave 15B-impl
  post-merge review)

  Surfaces from a 500-pass adversarial review of PR #262 after merge.
  Codex was unavailable for that PR (config issue) and Copilot caught
  two of three substantive bugs, but the post-merge review found four
  P2 hardening items that warranted a patch.

  ## Defensive instrumentation

  Both `tracedRequestMiddleware` (`@glasstrace/sdk/middleware`) and
  `withAsyncCausality` (`@glasstrace/sdk/async-context`) now wrap their
  respective `tracer.startActiveSpan` / `tracer.startSpan` calls in
  try/catch. OTel's noop tracer never throws, but a real provider
  under a misbehaving custom processor in coexistence could. If the
  tracer call throws, instrumentation falls back to direct invocation
  of the user's handler / continuation — a failing instrumentation
  must never break a user request hook.

  Behaviorally this is invisible until something else is already
  broken; it just means a buggy upstream OTel processor degrades the
  SDK to a no-op for that one call instead of taking down the user's
  request handler.

  ## Privacy documentation

  The `glasstrace.causal.middleware_for_request` attribute is the raw
  URL pathname. Pathnames in real applications can carry
  user-controlled data (user IDs, email addresses, document slugs,
  opaque keys). The SDK does NOT redact this attribute — that is the
  caller's responsibility per the general "don't put secrets in URLs"
  rule.

  This release adds the explicit privacy note to the `README.md`
  "Middleware-Ownership Tracing" section and to the
  `tracedRequestMiddleware` JSDoc so the contract is unambiguous at
  both the docs surface and the call site.

  ## Regression coverage

  Two new tests pin behavior that was fixed during the PR #262 review
  cycle but lacked dedicated regression coverage:

  - `tracedRequestMiddleware — sampler-drop discriminator`: a real
    provider whose sampler returns `NOT_RECORD` produces a non-recording
    span with a valid trace ID. The wrapper must take the normal
    enrichment path (NOT the SDK-not-registered fast path) and must NOT
    emit `middleware:skipped_uninstalled`. Without this guard, every
    sampled-out request in production deployments using head sampling
    would emit a spurious lifecycle event.

  - `withAsyncCausality — span activation`: child spans created inside
    the wrapped `fn()` callback are parented under the async-causality
    span. The fix used `context.with(trace.setSpan(...), fn)`; without
    it the child spans would become orphan roots in a separate trace
    tree.

  ## Tests

  2166 → 2168 passing.

  ## Backward compatibility

  Patch-level — no public API surface change, no behavior change for
  healthy code paths. The defensive try/catch only fires when an
  upstream OTel implementation is broken; the privacy note is purely
  documentary.

## 1.9.0

### Minor Changes

- 2760a50: feat(sdk): middleware-ownership and post-response async tracing
  (DISC-1537 + DISC-1539 / SDK-046)

  Two new instrumentation surfaces ship under additive subpaths.

  ### `@glasstrace/sdk/middleware` — `tracedRequestMiddleware`

  Wraps a Next.js `middleware.ts` (or any generic Web Fetch-shaped
  middleware function) and emits a span tagged with the
  `glasstrace.causal.middleware_for_request` causal-evidence attribute
  carrying the originating request's normalized path. The product-side
  trace summary uses this attribute to link the middleware span back to
  the owning HTTP request trace even when the middleware runs in the
  Edge Runtime, where AsyncLocalStorage parents are not propagated.

  The wrapper is admissible to the SDK's edge bundle: its closure
  imports only `@opentelemetry/api`, `@glasstrace/protocol`, and the
  edge-safe lifecycle bridge — no `node:*` built-ins and no `process`
  reads. The F003 closure scan
  (`packages/sdk/scripts/check-edge-bundle.mjs`) enforces this on every
  build.

  Path extraction prefers `req.nextUrl?.pathname` (set on
  `NextRequest`), falling back to parsing `req.url` via the WHATWG `URL`
  constructor (with a synthesized base when `req.url` is relative).
  When neither is parseable the causal attribute is omitted, per the
  "missing or unknown evidence is preferable to guessed evidence" rule.

  ### `@glasstrace/sdk/async-context` — `withAsyncCausality`

  A continuation-passing wrapper that captures the active OTel
  `SpanContext` at call time and binds it to a callback. When the
  callback runs later (Next.js `after()`, queue dispatchers, webhook
  fire-and-forget), the resulting async span carries:

  - An OpenTelemetry `Link` to the captured `SpanContext` (the OTel-
    native form, surfaces in standard OTel-aware UIs as a "follows
    from" relationship), and
  - The `glasstrace.causal.post_response_async` attribute carrying the
    originating trace ID (the transform-readable form), plus
    `glasstrace.causal.affects_http_status = false` and
    `glasstrace.causal.affects_http_duration = false` documenting that
    the async work does NOT participate in the root request's outcome.

  Both channels are emitted together so the SDK is robust to downstream
  transforms that resolve causality through either form. The wrapper
  emits the async span as a NEW root span (not parented to the
  originating trace) because post-response work runs outside the
  originating request's OTel context.

  Continuation-passing was chosen over global ALS propagation because
  ALS continuity across `after()` is uncertain — Next.js may schedule
  via `queueMicrotask` (preserves ALS) or via cross-tick scheduling
  (drops ALS). Continuation-passing makes the causality explicit: the
  captured `SpanContext` travels with the closure regardless of how the
  framework schedules it.

  The wrapper is also admissible to the edge bundle for the same reason
  as the middleware wrapper.

  ### Lifecycle events

  Three new events extend `SdkLifecycleEvents` under colon-namespaced
  prefixes (matching the existing `core:*`, `auth:*`, `otel:*`, and
  `health:*` convention):

  - `middleware:skipped_uninstalled` — `tracedRequestMiddleware`
    invoked before the SDK is registered. The wrapped middleware still
    runs; the span landed on the noop tracer.
  - `async:skipped_uninstalled` — `withAsyncCausality` continuation
    fired before the SDK is registered.
  - `async:no_originating_context` — `withAsyncCausality` invoked
    outside any active request span (no captured `SpanContext` at call
    time). The continuation still runs without a causal link.

  Each event is emitted at most once per process. Payloads are empty
  (no PII surface).

  A new edge-safe lifecycle bridge (`packages/sdk/src/optional-lifecycle.ts`)
  delivers events from edge-bundle-resident wrappers to the Node-only
  lifecycle module via a `Symbol.for()`-keyed `globalThis` slot; the
  slot is unset in edge runtimes and the emit call falls through as a
  clean no-op.

  ### Protocol additions (`@glasstrace/protocol` minor)

  Four new wire keys in `GLASSTRACE_ATTRIBUTE_NAMES`:

  - `CAUSAL_MIDDLEWARE_FOR_REQUEST` —
    `glasstrace.causal.middleware_for_request`
  - `CAUSAL_POST_RESPONSE_ASYNC` —
    `glasstrace.causal.post_response_async`
  - `CAUSAL_AFFECTS_HTTP_STATUS` —
    `glasstrace.causal.affects_http_status`
  - `CAUSAL_AFFECTS_HTTP_DURATION` —
    `glasstrace.causal.affects_http_duration`

  Existing constants are unchanged; this is a strict additive minor
  bump.

  ### Backward compatibility

  Strict additivity. No existing exported symbol's signature or type
  changed; no existing OTel attribute name changed; no existing
  lifecycle event was renamed or removed; the lifecycle state machines
  and transition tables are untouched. Existing
  `@glasstrace/sdk/trpc` `tracedMiddleware` is unaffected.

  Closes the SDK-side gap behind DISC-1537 (middleware-ownership
  causal evidence) and DISC-1539 (post-response async causal evidence).

## 1.8.0

### Minor Changes

- eb6195c: feat(sdk): three-state export-path circuit breaker (DISC-1568)

  The OTLP export path now wraps every batch through a CLOSED →
  OPEN → HALF_OPEN circuit breaker that protects production
  applications from emitting wasted traffic when the Glasstrace
  ingest endpoint is rejecting batches (invalid credentials, server
  outage, network partition).

  Behavior:

  - **Trip threshold**: 5 consecutive non-success export results.
    Any 2xx response resets the counter.
  - **OPEN backoff**: 30 seconds initially, doubling on each failed
    HALF_OPEN probe up to a 30-minute cap. While OPEN, span batches
    are dropped via the existing `recordSpansDropped` health
    surface; the BSP never retries (the OPEN window is itself the
    backoff). No buffering — the bounded-memory contract is
    preserved.
  - **Recovery**: when the timer expires, the next real batch acts
    as the probe. Success closes the breaker; failure doubles the
    timer and re-opens.
  - **Credential rotation**: when `setResolvedApiKey()` observes a
    different SHA-256 hash for the resolved API key, the breaker
    resets to CLOSED immediately. An in-flight HALF_OPEN probe at
    rotation time is invalidated via a generation counter so its
    outcome cannot poison the post-rotation breaker.
  - **FSM coupling**: while OPEN, the SDK reports
    `getStatus().tracing === "degraded"`; the breaker's recovery
    re-evaluates the SDK back to `"active"` only when no other
    degradation source (e.g., `OtelState.COEXISTENCE_FAILED`) is
    active. Centralised through a new
    `recomputeCoreFromDegradationSources()` helper.

  Observability:

  - Three new lifecycle events extend the existing `otel:`
    namespace: `otel:circuit_opened`, `otel:circuit_half_open`,
    `otel:circuit_closed`. Payloads are PII-safe by construction
    (closed `category` enum, fixed-template `message`, no URLs /
    headers / payload bodies).
  - `RuntimeStateLastError` gains a new `category: "export-circuit-open"`
    variant and an optional `exportCircuitCategory` field surfaced
    through `.glasstrace/runtime-state.json` and `npx glasstrace status`.
  - Existing `getStatus().tracing === "degraded"` signal now
    triggers on circuit OPEN.

  Backward compatibility: additive only. Applications that never
  see export failures observe identical behavior to prior versions.
  The `RuntimeStateLastError` `category` enum was already documented
  as non-breaking on extension. No public API was renamed or
  removed.

  Closes the original DISC-377 §Item 4 "invalid key wastes traffic"
  failure mode that the reverted PR #26 attempted to address.

## 1.7.0

### Minor Changes

- 71167d9: fix(sdk): CLI `--help` no longer mutates the project; static-discovery
  write failure now exits non-zero (Wave 15A — DISC-1565 + DISC-1566)

  ## DISC-1566 — `glasstrace --help` runs init and mutates the project

  Before this release, the CLI dispatcher routed any argv-2 starting
  with `-` to init's mutating path. So `glasstrace --help`,
  `glasstrace init --help`, and `glasstrace mcp add --help` all
  silently ran init / mcp-add against the user's project — modifying
  `instrumentation.ts`, `next.config`, `.env.local`, `.gitignore`,
  agent-instruction files, and creating `.cursor/`, `AGENTS.md`,
  `GEMINI.md` — without printing any help output.

  This release adds an explicit help-flag short-circuit BEFORE
  subcommand routing. Help invocations now print help text and exit
  cleanly; the project is never mutated.

  Detected variants:

  - `glasstrace --help`
  - `glasstrace -h`
  - `glasstrace init --help`
  - `glasstrace init -h`
  - `glasstrace mcp add --help`
  - composite invocations like `glasstrace init --yes --help` (the
    `--yes` is ignored — the user asked for help)

  `-help` (single-dash long form, non-canonical) is intentionally NOT
  treated as a help flag and falls through to subcommand routing as
  before.

  ## DISC-1565 — `glasstrace init` reports success while failing to write static discovery file

  Two fixes:

  1. **Bin now points at the CJS build.** The `bin` field used to point
     at `dist/cli/init.js` (ESM). In ESM, `require` is undefined, so
     the `atomic-write.ts` lazy-loader's `require("node:fs")` threw
     a ReferenceError; that was caught and surfaced as
     `node:fs is unavailable in this environment;
atomicWriteFileSync cannot be used here.` The `bin` now points
     at `dist/cli/init.cjs`, where `require` is the built-in. The
     static-discovery file is written successfully under the
     packaged-CLI runtime. The CJS bundle was already emitted by tsup;
     this change is bin-only.

  2. **Defensive: partial-success exits non-zero.** Even with the
     primary fix, a discovery-file write may still fail for legitimate
     reasons (permissions, full disk, read-only filesystem). Init now
     tracks the write outcome and returns exit code `1` when the
     write fails. The dispatcher's success message
     ("Glasstrace initialized successfully!") is gated on
     `exitCode === 0`, so the misleading success line is suppressed
     on partial-success. CI and scripts wrapping `glasstrace init`
     see the failure via exit code without having to grep stderr.

  ## Behavior changes (semver-minor)

  - **Exit code semantics:** `glasstrace init` now exits `1` when the
    static-discovery file write fails. Previously: exited `0` with a
    warning. **Affected:** users / CI scripts that interpret
    `glasstrace init` exit code. If you intentionally accept
    discovery-file write failures (e.g., environments without a
    writable static root), wrap the invocation:
    `glasstrace init || true`.
  - **Output gating:** the `Glasstrace initialized successfully!`
    stderr line is now gated on `exitCode === 0`; it does not print
    on partial-success. **Affected:** any script grepping for that
    exact string. Prefer reading exit code instead.
  - **`--help` behavior:** `glasstrace --help` etc. now print help and
    exit `0` without mutating the project. **Affected:** unlikely —
    any script depending on the prior bug to install Glasstrace via
    `glasstrace --help` should switch to `glasstrace init --yes`.

  These are minor-bumped because they change observable CLI behavior
  even though no exported API changed.

  ## Tests

  13 new tests across two new files:

  - `cli-help-dispatch.test.ts` (12 tests) — pin `isHelpInvocation`
    semantics across all six help-flag variants, the composite case,
    and the false-positive guards (`--helper`, `--help-me`,
    single-dash `-help`).
  - `init-discovery-file-failure.test.ts` (1 test) — `runInit` returns
    exitCode `1` when `writeDiscoveryFile` reports `action: "failed"`;
    warning text preserved; error not double-pushed.

  Pre-push gate: typecheck + lint + 2112 tests passing (up from 2099)

  - build (postbuild stamp gate passes for `1.6.1`-current).

## 1.6.1

### Patch Changes

- 5a8d71c: fix(sdk): name required `traceId` parameter in `get_test_suggestions`
  description rendered into agent instruction files (DISC-1571)

  `generateInfoSection()` injects MCP tool descriptions into
  `CLAUDE.md` / `.cursorrules` / `codex.md` when users run
  `npx glasstrace mcp add` or `npx glasstrace init`. The
  `get_test_suggestions` bullet previously read:

  > `get_test_suggestions` - Get test suggestions based on recent errors

  This omitted the `traceId` requirement that the MCP server's
  `GetTestSuggestionsParamsSchema` enforces. User AI agents read the
  description, called `get_test_suggestions({})`, and the MCP server
  rejected the request with a Zod validation error citing the missing
  `traceId`. The user paid in tokens and reasoning cycles for a 100%-
  failure interaction.

  This fix mirrors the wording shape from the `get_root_cause` fix that
  shipped in 1.3.6 (DISC-1536 SDK-side):

  > `get_test_suggestions` - Get test suggestions for a specific error
  > trace (requires a `traceId` from `get_latest_error`,
  > `get_error_list`, or `get_trace`)

  A regression test in `configs.test.ts` mirrors the existing
  `get_root_cause` test pattern: it pins on the
  `^- \`get_test_suggestions\``bullet, asserts the substring`traceId`, and asserts the description references at least one of
  the three trace-id source tools.

  The defect was identified during glasstrace-sdk PR #236's recon C7
  audit and reserved as DISC-1571 for a follow-up; this PR closes it.
  The audit also verified the four other tools in the same block
  (`get_latest_error`, `get_error_list`, `get_trace`,
  `get_session_timeline`) accurately reflect their schemas — no
  parallel defect remains.

## 1.6.0

### Minor Changes

- 9a7b70b: feat(sdk): bounded error stack + source provenance + framework-fallback
  markers in `glasstrace.error.*` (SDK-041; closes the SDK side of
  DISC-1535)

  The exporter now emits a curated set of bounded error-evidence
  attributes when a span carries OTel exception data (event-form via
  `recordException()` or attribute-form via `exception.stacktrace`),
  or when a framework rewrites the route to a fallback path. Product
  consumers (ingestion → MCP → dashboard) already accept these
  attributes via the MCP-019 / SCHEMA-033 rollout; the SDK side closes
  the missing emitter.

  ## New `@glasstrace/protocol` constants

  Additive (no rename, no removal). Wire keys remain in the existing
  `glasstrace.error.*` family.

  | SDK constant            | Wire key                           |
  | ----------------------- | ---------------------------------- |
  | `ERROR_STACK`           | `glasstrace.error.stack`           |
  | `ERROR_STACK_TRUNCATED` | `glasstrace.error.stack.truncated` |
  | `ERROR_STACK_REDACTED`  | `glasstrace.error.stack.redacted`  |
  | `ERROR_SOURCE`          | `glasstrace.error.source`          |
  | `ERROR_FRAMEWORK_KIND`  | `glasstrace.error.framework.kind`  |
  | `ERROR_ORIGINAL_PATH`   | `glasstrace.error.original_path`   |
  | `ERROR_FALLBACK_ROUTE`  | `glasstrace.error.fallback_route`  |

  Companion value-enum tuples + literal-union types for
  `glasstrace.error.source` and `glasstrace.error.framework.kind`
  land in a new `error-evidence.ts` module:

  - `ERROR_SOURCE_VALUES` / `ErrorSource`: `"otel_exception"` |
    `"otel_event"` | `"glasstrace_attribute"` |
    `"framework_runtime"` | `"framework_fallback"` |
    `"response_body"`.
  - `ERROR_FRAMEWORK_KIND_VALUES` / `ErrorFrameworkKind`:
    `"runtime"` | `"compile"` | `"fallback"` | `"unknown"`.

  ## SDK behaviour

  Bounded stack capture: when `exception.stacktrace` is observed
  (event preferred, span-attr fallback) on a non-OK span, the
  exporter promotes the string to `glasstrace.error.stack` after:

  1. Sanitization — absolute POSIX/Windows paths are normalized to a
     `<path>/<keep-marker>/...` form that drops the user's home
     directory and any other prefix above `node_modules`, `.next`,
     `.glasstrace`, `src`, `dist`, `build`, `lib`, `app`, or `pages`
     (priority order). `file:///` URIs are unwrapped first.
     `webpack-internal:///` and `node:` schemes pass through
     unchanged. URL query strings and fragments are stripped.
     Credentials are redacted using the same pattern set as
     `glasstrace.error.response_body` (Bearer / JWT / Glasstrace
     API keys / AWS access keys / generic key=value secrets).
  2. Truncation — bounded to 8192 UTF-8 bytes; `...[stack truncated]`
     marker appended on overflow. Codepoint-safe truncation via the
     same `TextEncoder`/`TextDecoder` walk used by
     `error-response-body.ts`.

  Sibling boolean attributes
  (`glasstrace.error.stack.truncated` /
  `glasstrace.error.stack.redacted`) tell product consumers when
  the bounded form is partial or has been modified.

  Source provenance: `glasstrace.error.source` is set to the
  narrowest applicable source — `otel_exception` (event) or
  `otel_event` (span attr) — when error facts come from OTel; or
  `framework_fallback` when the framework-rewrite path was the
  only signal. A more specific OTel source always wins over a
  broader framework marker.

  Framework fallback markers: when `http.route` is a known fallback
  (`/_error`, `/_not-found`, `/_404`, `/_500`) AND `http.url` /
  `url.full` / `http.target` resolves to a different requested
  path, the exporter emits `glasstrace.error.original_path`,
  `glasstrace.error.fallback_route`, and
  `glasstrace.error.framework.kind = "fallback"`. The existing
  `glasstrace.route` attribute is unchanged so existing consumers
  remain undisrupted; product reads `original_path` first per the
  Agent Evidence Engine SDK Attribute Contract §5.5.

  ## What's deferred

  - Parsed `StackFrameSummary[]` structured attribute output is
    out of scope for v1. Bounded `exception.stacktrace` input is
    the contract per SDK-041 Decision A; product owns
    `StackSummary` parsing via SCHEMA-033.
  - Next.js compile-diagnostic capture is out of scope per SDK-041
    Decision C. Production builds don't surface compile errors at
    runtime; dev-only capture would need new hooks plus a
    `captureConfig.compileDiagnostics` flag.
  - Health/degraded capture signals for unsupported framework
    modes are out of scope per SDK-041 Decision E. The SDK emits
    "missing evidence" implicitly by not setting attrs it cannot
    observe; explicit machine-readable degraded signaling lands
    separately under AESC §5.6.

  ## Backward compatibility

  All new wire keys are additive. Existing consumers keep working:

  - `glasstrace.error.message` / `code` / `category` / `field` /
    `response_body` continue to be emitted in the same situations as
    before; the _value_ that wins on a span where both an exception
    event AND `exception.*` span attributes are populated has flipped
    (see "Behavior change" below).
  - `glasstrace.route` continues to carry whatever the framework
    reports.
  - Spans without an exception event or fallback route emit no new
    attributes; the public API surface is unchanged for healthy
    spans.
  - Older SDK traces that lack the new fields are accepted by
    product ingestion as missing-evidence (the MCP-019 packet
    already disclaims absent stack / framework / log evidence).

  ### Behavior change — exception event now wins over span attributes

  Pre-1.6 SDKs preferred `attrs["exception.message"]` /
  `attrs["exception.type"]` over the `recordException()` event when
  both surfaces were populated on the same span. The OTel canonical
  surface for exceptions is the event; preferring span attributes
  mislabeled provenance and silently downgraded the higher-
  confidence source.

  This release inverts the precedence so the exception event wins.
  Span attributes are the fallback used only when no event is
  present, matching the new `glasstrace.error.stack` read order and
  the `glasstrace.error.source` precedence rule
  (`otel_exception > otel_event`).

  **Who is affected:** projects whose instrumentation populates BOTH
  the exception event AND `exception.*` span attributes with
  _different_ values. Most instrumentations choose one surface; this
  combination is rare. Projects on a single surface are unaffected
  because the alternative stays absent and the existing code path
  keeps firing.

  ## Tests

  - `error-stack.test.ts` (new file, 21 tests): pure helper coverage
    for path normalization (POSIX abs / Windows abs / `file://` /
    webpack-internal / node: / fallback-to-basename / rightmost-
    marker anchoring), URL query/fragment stripping, credential
    redaction (positive + false-positive guards), truncation
    (codepoint-safe boundary walk), end-to-end `prepareStack`.
  - `enriching-exporter.test.ts` (existing file, +14 tests in
    "SDK-041 error evidence v1" + 6 tests in "extractPathOnly"):
    exporter integration coverage for stack capture from event-
    attrs vs span-attrs, `glasstrace.error.source` enum,
    framework-fallback positive/negative cases, oversized
    truncation, credential redaction in the rendered attribute,
    backward-compat (no new attrs on healthy spans), provenance
    precedence when both OTel and framework signals fire.

  Pre-push gate: typecheck clean, lint clean, 2096 tests passing
  (was 2056 + 40 new), build clean (F003 edge gate passes,
  postbuild stamp gate passes).

  Wave 14 of the 2026-05-08 SDK-041 wave plan; closes DISC-1535
  PARTIAL → RESOLVED on the SDK side. Stable release is gated on
  the canary publishing cleanly and a product round-trip
  verification against the Agent Evidence Engine MCP-019 path.

## 1.5.1

### Patch Changes

- 3fb513f: fix(release): canary publish now bakes the canary version into the dist
  bundle (DISC-1602)

  The `release.yml` workflow previously ran `npm run build` BEFORE
  `npx changeset version --snapshot canary`. Because tsup's
  `define: { __SDK_VERSION__: pkg.version }` reads `package.json#version`
  at build time, the built `dist/` shipped with the _pre-snapshot_ stable
  version baked in; `changeset publish --tag canary` then tagged the same
  artifact under the new canary version, but the bundled
  `__SDK_VERSION__` literal in CJS CLI bundles still encoded the stable.
  Validation directly observed this on the SDK-050 canary
  `0.0.0-canary-20260507174112`: `dist/cli/upgrade-instructions.cjs`
  contained `"1.4.0"`, so the canary's `npx glasstrace upgrade-instructions`
  stamped `<!-- glasstrace:mcp:start v=1.4.0 -->` rather than the
  canary version.

  Fix: reorder the canary publish steps so `Snapshot version` runs before
  `Typecheck` / `Test` / `Build`. The `if: canary` gate is unchanged; for
  stable, the snapshot step is skipped and the version that landed via
  the merged Version Packages PR flows through the build correctly.

  Defense-in-depth: a new postbuild gate
  (`packages/sdk/scripts/check-sdk-version-stamp.mjs`) reads the current
  `package.json#version` and asserts the literal appears in every CJS
  CLI bundle. A future workflow reorder (or a tsup config drift that
  removes the `define`) now fails CI before the publish step instead of
  shipping a silently mis-stamped tarball.

  No public API surface changes; consumers of stable
  `@glasstrace/sdk@1.5.0` are unaffected. The bug only manifests on
  canary publishes; subsequent canaries cut from the fixed workflow will
  stamp correctly.

## 1.5.0

### Minor Changes

- 1eb0c64: feat(sdk): cost-aware cross-tool decision paragraph and version-stamped
  upgrade-refresh mechanism for the agent-instruction managed section
  (SDK-050; covers DISC-1593 and DISC-1592 — renumbered 2026-05-07 from
  DISC-1585 / DISC-1586 after the contract-drift audit (PR #964) claimed
  DISC-1586 / 1587 / 1588 in the same window)

  ## Summary

  The Glasstrace MCP managed section that the SDK injects into agent
  instruction files (CLAUDE.md / codex.md / .cursorrules) now opens with
  a cost-aware cross-tool decision paragraph and carries an SDK version
  stamp on its start marker. Two new behaviours flow from the stamp:

  1. `npx glasstrace upgrade-instructions` — refreshes the managed
     section in every detected agent instruction file in one run.
     Idempotent and safe to re-run; only files that already contain a
     Glasstrace marker pair are touched, so a hand-written `CLAUDE.md`
     without a Glasstrace block is left alone.
  2. A one-time stderr warning at SDK init when the running SDK version
     is strictly newer than the on-disk stamp. Respects the
     `GLASSTRACE_DISABLE_UPGRADE_NOTICE` opt-out
     (`"1"` / `"true"` / `"yes"`, case-insensitive). Stderr only,
     Node-only, no file mutation, no network I/O, never throws.

  The decision paragraph names cheapest-orientation routing per symptom
  class — `get_latest_error` / `get_error_list` for current errors,
  `find_trace_candidates` for known route/procedure/URL fragments — and
  restates the no-candidates / no_traces_found "scoped retrieval result,
  not absence proof" framing in user-facing language so the agent does
  not give up on a miss.

  ## Backward compatibility

  The marker parser recognises both legacy unstamped markers
  (pre-SDK-050) AND stamped markers (SDK-050+). An upgrading user's
  first re-render replaces the existing block in place rather than
  appending a duplicate; subsequent re-renders write the stamped form.
  A stale managed section with an unparseable stamp is treated as
  "stamp present but unknown" — the warning is suppressed, but the
  upgrade command still re-renders correctly (overwriting the
  unparseable stamp with a fresh one).

  The stamp encodes only the SDK semver string (e.g. `1.4.0`,
  `0.0.0-canary-20260508120000`); arbitrary or environment-derived
  content is rejected at the render site.

  ## Validation Prompt

  <!-- version: 1 -->

  # Validation Prompt: SDK-050 Canary Verification

  **Authoritative source for the prompt that goes to the validation agent when
  the SDK-050 canary publishes.** Do not duplicate the prompt elsewhere — copy
  from this file (or from the SDK canary release notes that embed this file
  verbatim per SDK-050's release-artifact requirement).

  **Brief:** `docs/task-briefs/SDK-050.md`
  **Discoveries covered:** DISC-1593 (decision paragraph; renumbered
  2026-05-07 from DISC-1585), DISC-1592 (refresh-on-upgrade mechanism;
  renumbered from DISC-1586)
  **Sibling brief (separate canary):** `docs/task-briefs/MCP-025.md` — uses a
  similar but distinct prompt at
  `docs/validation-prompts/MCP-025-server-verification.md` (will be authored
  when MCP-025 is ready to ship; do not conflate the two prompts).

  ## How to use

  1. The SDK conductor publishes an `@glasstrace/sdk` canary that satisfies
     SDK-050's Acceptance Gates. The canary's changeset description embeds
     the full prompt below (copy verbatim from this file).
  2. Erik (or whoever cuts the canary) opens the GitHub release page for the
     canary. The prompt is at the bottom of the release notes.
  3. Copy the prompt. Replace `<CANARY_VERSION>` with the actual canary
     version string (e.g. `0.0.0-canary-20260508120000`). Hand it to the
     validation agent in `glasstrace-validation`.
  4. Validation agent returns the report. The conductor reviews it against
     SDK-050's Acceptance Gates. If green, conductor closes DISC-1593 and
     DISC-1592 and marks SDK-050 IMPLEMENTED. Erik then cuts the stable
     `@glasstrace/sdk` release.

  ## The prompt (copy from below verbatim)

  ```
  TASK: Verify @glasstrace/sdk canary <CANARY_VERSION> against the
  2026-05-07 MCP-natural baseline.

  CONTEXT
  The canary ships SDK-050: (1) a new cost-aware cross-tool decision
  paragraph injected at the top of the Glasstrace MCP managed section in
  agent instruction files (CLAUDE.md / .cursorrules / codex.md / etc.),
  (2) a version-stamp on the section's start marker, (3) a one-time
  stderr warning at SDK init when the stamped version is older than the
  running SDK version, and (4) idempotent re-render via
  `npx glasstrace mcp add` (or `upgrade-instructions` if introduced).
  The MCP server is UNCHANGED from baseline — MCP-025 is not part of
  this canary. Expect SDK-side behaviour shifts only.

  BASELINE (2026-05-07 half-run, MCP-natural condition):
  - find_trace_candidates: 8 calls (3 found, 5 zero-candidate)
  - get_trace: 2 calls (1 rejected for missing timeWindow, 1 succeeded)
  - get_latest_error / get_error_list / get_root_cause /
    get_session_timeline / get_test_suggestions: 0 calls each
  - Specific zero-candidate sequences: RACE-004, RACE-005, DATA-005,
    PERF-009 (first attempt), DATA-004
  - PERF-009 sequence: candidate row -> get_trace({ correlationId }) ->
    rejected -> manual retry with { url, method, timeWindow } -> success

  PRE-FLIGHT
  Throughout PRE-FLIGHT, treat <CANARY_VERSION> as the literal version
  string Erik substituted at the top of this prompt (e.g.
  `0.0.0-canary-20260508120000`). Run all PRE-FLIGHT steps against an
  isolated copy of the 2026-05-07 validation target — clone the target
  to a fresh working directory and run PRE-FLIGHT there so PRE-FLIGHT 4's
  artificial stamp edit cannot corrupt the harness baseline. Before any
  edit in PRE-FLIGHT 4, also save a byte-for-byte backup of the agent
  instruction file so restoration is recoverable if the upgrade command
  fails. EXECUTION still runs on the same project and agent instruction
  file target as the 2026-05-07 half-run; only PRE-FLIGHT inspection
  happens on the clone.

  The "agent instruction file" referred to throughout this prompt is the
  same file the SDK detected and wrote into during the 2026-05-07
  half-run (see the half-run artifacts for the exact path and target
  type — CLAUDE.md / .cursorrules / codex.md / agent.md / generic
  fallback). Use that one file. Do not switch targets.

  The "upgrade command" referred to throughout this prompt is whatever
  command the SDK canary documents for re-rendering the managed section
  (per SDK-050: either `npx glasstrace upgrade-instructions` or
  `npx glasstrace mcp add` if that command is now documented as
  idempotent). Determine the canonical command from the canary's
  release notes / `--help` output and use it consistently.

  1. Install @glasstrace/sdk@<CANARY_VERSION> in the validation target
     used for the 2026-05-07 half-run. Use the same project, same agent
     instruction file target. Run the canary's upgrade command once to
     render the managed section under the canary.
  2. Confirm the managed Glasstrace MCP block in the agent instruction
     file (CLAUDE.md / equivalent) now contains:
     a. A decision paragraph BEFORE the per-tool bullet list.
     b. The phrases "runtime evidence would materially reduce
        uncertainty" and "not proof the bug is absent" (the SDK
        implementation may rephrase, but both load-bearing semantic
        claims must be present: (i) Glasstrace MCP is conditionally
        worth calling when runtime evidence reduces uncertainty, and
        (ii) a no-candidates / no_traces_found result is a scoped
        retrieval result, not absence of the bug). If wording diverges,
        quote the actual rendered text in the report so the conductor
        can adjudicate.
     c. Routing references for cheapest-first calls: "get_latest_error"
        and "get_error_list" for current-error symptoms;
        "find_trace_candidates" for known route/procedure.
     d. A version stamp on the start marker. For markdown targets the
        shape is `<!-- glasstrace:mcp:start v=<actual-version> -->`;
        for plain-text targets (e.g. `.cursorrules`) the shape is
        `# glasstrace:mcp:start v=<actual-version>`. The literal token
        after `v=` must equal the installed canary version string from
        step 1 (compare exact-match, including any pre-release suffix).
  3. Confirm idempotent re-render: run the upgrade command a second time
     on the same file; confirm content outside the markers is byte-for-
     byte unchanged and content inside the markers is byte-for-byte
     identical to the first run. Capture both renders as artifacts (e.g.
     `pre-flight/render-1.txt`, `pre-flight/render-2.txt`) and a diff.
  4. Confirm the stale-warning behaviour:
     a. Edit only the start-marker line to replace the stamped version
        with `v=1.0.0` (leave the body unchanged). Save a backup first.
     b. Start the SDK in a fresh process (no env overrides). Capture
        stderr. Confirm exactly one warning line appears, that it
        mentions the upgrade command, and that no warning appears on
        stdout. Re-run the SDK in another fresh process and confirm
        the warning still appears (the "once per process boot" rule
        means once per process, not once ever).
     c. Start the SDK in a fresh process with
        `GLASSTRACE_DISABLE_UPGRADE_NOTICE=true` set in the
        environment. Confirm zero warning lines on stderr.
     d. Unset the env var, start the SDK in a fresh process, and
        confirm the warning returns. This proves the opt-out is
        env-driven, not persistent file state.
     e. Restore the start marker by either (i) restoring the backup
        file from step 4a, or (ii) re-running the upgrade command to
        regenerate a current stamp. Confirm via `diff` against the
        pre-PRE-FLIGHT-4 backup that restoration succeeded before
        proceeding to EXECUTION. If restoration cannot be confirmed,
        stop and report; do not proceed to EXECUTION on a corrupted
        target.
     f. Additionally confirm Acceptance Gate 4 from the brief: with a
        current (non-stale) stamp in place, starting the SDK in a
        fresh process emits zero stderr warning lines about a stale
        managed section.

  EXECUTION
  Run the same MCP-natural condition as the 2026-05-07 half-run. Same
  scenarios, same agent harness, same measurement window. Same agent
  model and configuration — read the model name, version pin, and
  harness configuration from the 2026-05-07 half-run manifest under
  `glasstrace-validation/results/2026-05-07/` (or whatever the harness's
  canonical baseline path is in that repo); do not infer or substitute.
  Re-execute the full scenario set against the canary-rendered agent
  instruction file; do not reuse cached agent state, cached scenario
  seeds, or cached MCP responses. Start each scenario from a fresh
  agent context. If the harness supports scenario seeds, use the same
  seeds the half-run recorded.

  If the harness fails partway through a scenario, log the failure,
  finish the remaining scenarios, and report the partial run; do not
  silently restart in a way that double-counts tool calls.

  CAPTURE
  For each scenario, log:
  - Every MCP tool call: tool name, params (redacted of values, just
    the parameter-key shape), response category (found / zero-candidate
    / rejected / succeeded / errored — where "errored" means the tool
    was invoked but failed before returning a structured response), and
    the agent's next action. Count an "errored" call toward the total
    call count for that tool but track it separately so the report can
    distinguish it from the four success/empty/rejected categories.
  - Whether the agent fell back to source inspection without exhausting
    MCP tool options.
  - The full rendered managed-section text from the agent instruction
    file at the start of the run (so the conductor can confirm the
    decision paragraph and version stamp the agent actually saw).

  REPORT (return exactly this structure; render as machine-parseable
  markdown — numbered top-level items, fenced code blocks for
  sequences, no prose preamble before item 1)
  1. Tool-call totals across all scenarios. Counts are total invocations
     (including errored). Sub-buckets sum to the total per tool:
     - find_trace_candidates: <count> (<found> found / <empty> zero /
       <rejected> rejected / <errored> errored)
     - get_trace: <count> (<succeeded> / <rejected> / <errored>)
     - get_latest_error: <count>
     - get_error_list: <count>
     - get_root_cause: <count>
     - get_session_timeline: <count>
     - get_test_suggestions: <count>
  2. Per-scenario tool sequences for: RACE-004, RACE-005, DATA-005,
     PERF-009 (full sequence including any retries — the baseline
     PERF-009 was: candidate row -> get_trace({correlationId}) ->
     rejected -> manual retry with {url, method, timeWindow} ->
     success), DATA-004 (the same five scenarios as baseline). Format
     each as one fenced line:
     `<scenario>: tool1(params-shape) -> outcome -> tool2(...) -> outcome`
  3. Specifically for PERF-009: did the agent still produce a
     malformed get_trace({ correlationId }) call? (Expected: yes,
     because MCP-025 is not in this canary; the SDK-side decision
     paragraph alone does not fix the rejection envelope. We measure
     this so MCP-025's eventual impact can be attributed. If the agent
     does NOT produce the malformed call, that is a noteworthy
     anomaly — flag it under item 8 with the actual sequence. Do not
     count its absence as a pass.)
  4. Candidate-success ratio:
     `find_trace_candidates calls returning >=1 candidate /
      total find_trace_candidates calls (including errored)`
     Report as "<numerator>/<denominator> (<percentage>%)". Baseline
     was 3/8 (37.5%).
  5. Cross-tool reach. For each of get_latest_error, get_error_list,
     get_root_cause, get_session_timeline, get_test_suggestions, report
     on its own line: "<tool>: Y, <count> calls across <N> scenarios:
     <scenario-ids>" or "<tool>: N". "Y" requires at least one
     invocation in any scenario (the baseline had zero across all
     scenarios for these five tools, so any non-zero count is a Y).
  6. Fallback-to-source-inspection: in how many scenarios did the agent
     give up on MCP and read source code instead? Define "fell back" as
     the agent issuing a source-read action (file read / grep / code
     inspection of the application under test) after one or more
     zero-result or rejected MCP calls without first attempting any
     other Glasstrace MCP tool. Report `<count>/<total-scenarios>` and
     list the scenario IDs. Compare to the same metric in the half-run
     baseline.
  7. Token-cost delta vs baseline. The 2026-05-07 half-run reported a
     1.22x median agent time multiplier and a 1.75x average agent
     tokens multiplier for MCP-natural over the no-MCP control
     condition. To compute comparable multipliers in this run, also
     execute the no-MCP control condition the half-run used (same
     scenarios, same model, MCP server disabled), or — if a control run
     already exists alongside the canary execution — reuse it and cite
     its path. Report:
     - Median agent wall-clock time per scenario: MCP-natural / control
       (seconds), and the multiplier.
     - Average agent tokens per scenario: MCP-natural / control, and
       the multiplier.
     - Aggregation is per-scenario then averaged across scenarios; do
       not aggregate per-call.
     Compare the two multipliers to the baseline (1.22x time, 1.75x
     tokens). If a control run is not available, state that explicitly
     and report the absolute MCP-natural numbers; the conductor will
     adjudicate.
  8. Any anomalies, harness errors, or sequences that diverge
     meaningfully from baseline expectations. Include any PRE-FLIGHT
     step that did not return a clean green.

  ARTIFACTS
  - Save the full run under
    `glasstrace-validation/results/<YYYY-MM-DD>-sdk050-canary-<CANARY_VERSION>/`
    using the actual run date and canary version string. Use only
    filesystem-safe characters in the path (replace any `+` in the
    canary version with `-`).
  - Inside that directory, include at minimum:
    - `pre-flight/` with the rendered managed-section text after
      install (`render-1.txt`), after the second upgrade run
      (`render-2.txt`), the diff between them, the captured stderr
      from each stale-warning sub-test, and the restored-file diff.
    - `report.md` containing the REPORT section verbatim.
    - `scenarios/<scenario-id>/` for each scenario, with the captured
      tool-call log and any scenario-specific artifacts the harness
      emits.
    - `agent-instructions-rendered.<ext>` — a copy of the full agent
      instruction file (markers and managed section included) as the
      agent saw it during EXECUTION.
  - Return the run path along with the report.

  DO NOT
  - Modify the validation harness prompts (the per-scenario prompts the
    harness sends to the agent). The decision paragraph must reach the
    agent through the SDK-injected instruction file, not through a
    sweetened harness prompt. Installing the canary, pinning the same
    agent model, and configuring scenario seeds is allowed; rewriting
    scenario prompt text is not.
  - Modify the MCP server, its responses, or its tool descriptions.
    MCP-025 is not in this canary.
  - Run on a different agent model / version / temperature / tool-use
    configuration than the 2026-05-07 baseline.
  - Treat "or equivalent semantics" in PRE-FLIGHT 2b as license to
    accept text that drops either of the two load-bearing claims listed
    there. If either claim is missing, report it under item 8.
  ```

  ## Acceptance criteria for closeout

  The conductor closes DISC-1593, DISC-1592, and SDK-050 only when the
  returned report shows ALL of the following:

  - **Pre-flight 1–4 all confirm green.** The decision paragraph is
    present (with both load-bearing semantic claims from PRE-FLIGHT 2b),
    the version stamp is on the start marker and equals the installed
    canary version, idempotent re-render is byte-for-byte stable inside
    the markers and untouched outside, the stale-warning behaviour fires
    exactly once per process boot pointing at the upgrade command, the
    `GLASSTRACE_DISABLE_UPGRADE_NOTICE=true` opt-out suppresses it,
    unsetting the env var brings it back, and a current (non-stale)
    stamp produces zero stderr warnings (brief Acceptance Gate 4).
  - **Cross-tool reach is non-zero.** The agent invokes at least one of
    `get_latest_error` / `get_error_list` / `get_root_cause` /
    `get_session_timeline` / `get_test_suggestions` across scenarios
    where the baseline had zero such calls. Specifically, current-error
    symptoms (RACE-004 / RACE-005 / DATA-004) should now reach for
    `get_latest_error` or `get_error_list` first.
  - **Candidate-success ratio improves** vs baseline 3/8 (37.5%). A
    meaningful lift threshold is to be set by the conductor at review
    time, not pre-committed here, because the small N of the half-run
    baseline does not support a hard percentage gate. The qualitative
    question is: is the agent making fewer single-parameter guesses?
  - **PERF-009-class rejection still occurs.** This is a feature, not a
    bug, of this canary. Confirms the rejection-envelope fix really does
    belong to MCP-025 and is not accidentally addressed by the SDK
    change.
  - **Fallback-to-source-inspection rate does not regress** vs baseline.
  - **Token-cost multipliers do not regress** materially vs baseline.

  If the report misses any of these, conductor triages: file follow-up
  discoveries, decide whether to iterate the canary or hold the SDK
  release for a v2 canary that addresses the gap.

## 1.4.0

### Minor Changes

- 6c516bc: feat(sdk): add `recordSideEffect` API with `sideEffectEvidence` capture-config opt-in (SDK-049)

  Introduces a public `recordSideEffect(input)` API that attaches
  allowlisted, non-sensitive semantic metadata about side-effect
  operations (`email`, `calendar_link`, `webhook`, `external_api`,
  `queue`, `after_callback`) to the current active OTel span. The SDK
  enforces the allowlist client-side as defense-in-depth; the
  glasstrace-product storage filter is a second defense, not the
  primary boundary. Behavior is observational only: no provider calls,
  no retries, no duplicates, never throws.

  The new `captureConfig.sideEffectEvidence` flag defaults to `false`;
  no `glasstrace.side_effect.*` attribute reaches the wire unless the
  account explicitly opts in. Unsafe values (URLs, emails, tokens,
  headers, prose-shaped whitespace) are silently dropped and replaced
  with integer omission counters that never echo the rejected input.

## 1.3.9

### Patch Changes

- 5bfe293: feat(sdk): add `find_trace_candidates` to MCP tool listing in agent-instruction output (SDK-048; aligns with glasstrace-product seven-tool MCP server contract at SHA 2fbec03f)

## 1.3.8

### Patch Changes

- c5da627: fix(sdk): emit Claude-compatible MCP config from generic init path; legacy on-disk shape continues to refresh on credential rotation (DISC-1572)

  The generic `.glasstrace/mcp.json` written when no agent is detected
  now includes `"type": "http"` on the `glasstrace` server entry. This
  matches the Claude branch of `generateMcpConfig` and is required by
  Claude Code's `--strict-mcp-config` validator; without it, fresh
  non-interactive `glasstrace init` runs produced configs that Claude
  rejected with `Does not adhere to MCP server configuration schema`.

  Existing on-disk files written by older SDK versions (without
  `type: "http"`) continue to be recognized as SDK-managed by
  `mcpConfigMatches`. The matcher now retries the canonical-JSON
  comparison once with `type: "http"` stripped from the expected
  `mcpServers.glasstrace` entry; any other field divergence still
  reports a mismatch and preserves user edits. Existing legacy files
  are upgraded to the new shape automatically on the next credential
  rotation or `glasstrace init` re-run.

## 1.3.7

### Patch Changes

- f7848d6: docs: clarify that `/.well-known/glasstrace.json` is the sole supported
  discovery contract; runtime handler at `/__glasstrace/config` is internal
  compatibility only (DISC-1417)

  The README and CHANGELOG previously contained two statements that read as
  contradictory: the SDK does not require `createDiscoveryHandler` to be
  wired up, and the SDK installs an automatic runtime handler in anonymous

  - development mode. Both statements are individually true, but together
    they failed to describe which surface external consumers should rely on.

  The supported discovery contract is the static file
  `public/.well-known/glasstrace.json` (or `static/.well-known/glasstrace.json`
  on SvelteKit) written by `npx glasstrace init`; the browser extension reads
  it directly. The internal runtime handler at `/__glasstrace/config` exists
  solely as backwards compatibility for older consumer integrations during
  local development. It is not documented for use, not covered by validation
  expectations, and may be removed in a future release without a deprecation
  cycle.

  This release updates the README, CHANGELOG, the `glasstrace init` failure
  warning, the protocol package's wire-format file comment, the `@internal`
  JSDoc on `createDiscoveryHandler`, and the runtime install-site comments
  in `register.ts` to all tell the same story. No public API changes; no
  behavioral changes.

## 1.3.6

### Patch Changes

- 4faf157: DISC-1536 SDK-side fix. Update the `get_root_cause` description rendered by `generateInfoSection()` and injected into agent instruction files (`CLAUDE.md`, `.cursorrules`, `codex.md`, etc.) so the user's AI coding agent learns that `get_root_cause` requires a `traceId` (sourced from `get_latest_error`, `get_error_list`, or `get_trace`). The injection runs from both `npx glasstrace mcp add` and `npx glasstrace init`. Previously the description omitted the requirement, so AI agents would call `get_root_cause` with no arguments and the MCP server would reject the request, costing the user tokens and reasoning cycles on a broken interaction. To pick up the corrected guidance, re-run `npx glasstrace mcp add` (or `npx glasstrace init`) in your project so the updated instructions are written into your agent's instruction file.
- fd08b8b: DISC-377 Item 1 fix. Convert two unconditional `node:fs` / `node:path`
  ESM imports in `runtime-state.ts` to a cached `require()` + try/catch
  loader matching the precedent at `heartbeat.ts:150-159`, so the module
  loads cleanly under non-Node runtimes (browser bundles, Vercel Edge,
  Cloudflare Workers, Deno without Node-compat). Wave 8 8D guarded the
  `require()` calls inside the writer body via the existing
  `isSyncFsAvailable()` probe; Wave 13 closes the residual top-of-file
  import gap that previously failed at module-evaluation time before the
  probe could run. No public API change; trace-capture behavior under
  Node is unchanged, and `startRuntimeStateWriter` retains its
  synchronous `void` return contract.

## 1.3.5

### Patch Changes

- 321b4c9: DISC-1556 Option A fix. Replace constructor-name proxy classification
  (`probeTracer.constructor.name !== "ProxyTracer"`) with structural
  classification at both probe sites in `otel-config.ts` and `register.ts`.
  The constructor-name check failed under Next 16's bundler/minifier,
  which renames `@opentelemetry/api`'s `ProxyTracer`/`ProxyTracerProvider`
  to short minified names (`ek`/`e_`/`eN`/`ew`); the SDK then misidentified
  its own bundled proxy as an external provider and silently failed to
  export traces under `next build && next start`. Auto-attach detection
  now classifies the SDK's own bundled proxy correctly under bundler
  minification, verified against the `clean-next-sdk130` validation
  fixture. The manual `createGlasstraceSpanProcessor()` workaround
  documented in the README remains supported.

## 1.3.4

### Patch Changes

- b2dc24b: DISC-1556 P0 hotfix (Option C from SDK-044 brief). Convert the silent
  "auto-attach returned null" failure mode into a structured fail-loud
  diagnostic: the SDK now emits a typed `otel:failed` lifecycle event,
  persists a `lastError` field to `runtime-state.json` (with a sanitized
  provider class identifier — never URLs, headers, or credentials), and
  escalates the coexistence-path guidance log level from `warn` to
  `error` under `NODE_ENV=production`. The README gains a "Production
  deployment under Next 16" section documenting the manual
  `createGlasstraceSpanProcessor()` workaround as the production-supported
  integration path and the `getStatus().tracing === "not-configured"`
  programmatic failure signal. Trace export under Next 16 production is
  still impacted (auto-attach detection extension is queued for a follow-
  up wave); this hotfix makes the failure observable so users can apply
  the manual workaround. Existing public APIs (`getStatus`,
  `RuntimeState`) gain optional fields only; no breaking changes.

## 1.3.3

### Patch Changes

- eae8c6c: Stack-frame parser now accepts Next.js webpack-internal paths with parenthesized App Router markers (`(rsc)/`, `(middleware)/`, `(api)/`, `(client)/`, `(server)/`, `(action)/`, `(app)/`, `(pages)/`). Previously these frames were silently rejected because the file-capture regex excluded `(`, leaving `glasstrace.source.{file,line}` attributes missing for the primary Next.js App Router segment in dev mode and self-hosted production builds. The eval-frame guard is preserved via a precise negative lookahead that targets only V8's nested `eval (eval at ...)` shape.

## 1.3.2

### Patch Changes

- 807b4ca: Suppress benign `node:fs unavailable` warning emitted on Next.js dev/start
  server startup. The runtime-state writer now silently skips when synchronous
  `node:fs` is unreachable — traces still capture as before; only diagnostic
  noise is removed (DISC-1555).

## 1.3.1

### Patch Changes

- 401e741: chore: update internal `@drift-check` anchors to reference the renamed component design `sdk-architecture.md` (was `sdk-2.0.md`).

  The companion glasstrace-product change renamed `docs/component-designs/sdk-2.0.md` to `docs/component-designs/sdk-architecture.md` so the filename no longer pins to a specific milestone. The rename ships the doc as a milestone-neutral architecture reference covering both the published SDK 1.x line and the next-major target.

  This patch propagates the rename into SDK-side citations so the published `dist/*.d.ts` JSDoc tooltips that consumers see in their IDE (e.g., on `DevApiKeySchema`, `AnonApiKeySchema`, `GLASSTRACE_ATTRIBUTE_NAMES`, `MAX_PENDING_SPANS`, `WELL_KNOWN_GLASSTRACE_PATH`) point at the live filename. `DRIFT.md` is updated in the same change.

  No runtime behavior change. No public API change. Pure JSDoc / documentation-string update.

## 1.3.0

### Minor Changes

- c5a4d31: feat(sdk): emit `glasstrace.build.hash` and `glasstrace.source.{file,line}` on error spans (SDK-040 / DISC-1543).

  The SDK now stamps three previously-dormant span attributes that the ingestion service has been reading since `@glasstrace/protocol@0.19.0`. With the writers in place, the source-map upload + resolver pipeline becomes live end-to-end: the dashboard renders mapped frames for error traces and the enrichment LLM prompt receives concrete source-location context.

  - `glasstrace.build.hash` — stamped on every server span. Read once at module load from `process.env.GLASSTRACE_BUILD_HASH`. Set the env var in your build/deploy step (typically `GLASSTRACE_BUILD_HASH=$(git rev-parse HEAD)`) so the runtime trace and the build-time source-map manifest agree on the same hash. When the env var is unset, the attribute is silently omitted — no behavior change for projects that have not adopted the convention.
  - `glasstrace.source.file` and `glasstrace.source.line` — stamped on the `glasstrace.error` span event by the manual `captureError()` API. Values come from the top user-attributable frame of `Error.stack`, with V8 internal frames (`node:internal/*`, `node:fs`, etc.) and SDK-internal frames (`@glasstrace/sdk` package or in-tree `packages/sdk/src/capture-error.ts`) skipped automatically. The reported `file:line` is the compiled-output path; ingestion's source-map resolver maps it back to the original source via the uploaded manifest.

  `@glasstrace/protocol` adds `BUILD_HASH: "glasstrace.build.hash"` to `GLASSTRACE_ATTRIBUTE_NAMES` (the other three keys were already declared). All three new emissions are additive, edge-bundle-clean, and gated to error spans where they apply — non-error spans do not carry source-frame attributes. The `process.env.GLASSTRACE_BUILD_HASH` read lives in a Node-only helper module (`build-info.ts`) imported only by `enriching-exporter.ts`, which is itself excluded from the edge bundle by the F003 runtime-partition gate.

  See the new "Source maps" section of the SDK README for the full configuration surface and behavior.

## 1.2.1

### Patch Changes

- 5f8ddf2: fix(sdk): coerce string-shaped HTTP status codes at exporter read sites (DISC-1551). The OpenTelemetry attribute spec allows `string | number | boolean | array`, and several real-world instrumentations (custom HTTP wrappers, edge runtimes that round-trip headers verbatim) emit `http.status_code` and `http.response.status_code` as strings. The exporter previously read these via TypeScript `as number | undefined` casts that perform no runtime coercion, so a string-shaped `"200"` would (a) flow verbatim into the public `glasstrace.http.status_code` wire attribute (which downstream ingestion expects to be numeric) and (b) defeat the Next.js timing-race inference block (DISC-1134, DISC-1204) whose `=== 200` / `=== 0` discriminators were `false` against the string forms. A new `coerceHttpStatus(value: unknown): number | undefined` helper (co-located with `isHttpErrorStatus` in `error-response-body.ts` and used by the latter for symmetry) is now invoked at the read site so `statusCode` is a `number | undefined` at runtime, not just at the TS type level. Whitespace-only strings (e.g. `"   "`, `"\t\n"`) are rejected before coercion to avoid `Number()`'s blank-string-to-zero behavior masking a fallback to `http.response.status_code` or synthesizing a fake `0` on the wire payload.

## 1.2.0

### Minor Changes

- 96d5027: feat(sdk): add `@glasstrace/sdk/trpc` subpath with `tracedMiddleware` helper for tRPC middleware-chain instrumentation (DISC-1217). Wraps each user-supplied tRPC middleware in an OTel span (via `tracer.startActiveSpan`) so enrichment can pinpoint _which_ middleware short-circuited a request rather than just _that_ an auth or tier check failed. Spans are children of the HTTP server span via standard OTel context propagation; the existing `glasstrace.trpc.procedure` attribute (DISC-1215) is not duplicated. `@trpc/server` is declared as an optional peer dependency (`^10.0.0 || ^11.0.0`); the subpath is excluded from the root barrel and tree-shakeable for projects that do not use tRPC.

### Patch Changes

- 0b9c4f8: Fix Next.js 16 + Turbopack `RangeError: Map maximum size exceeded` crash by making `installContextManager()` idempotent across module re-evaluations. Under `next dev --turbopack`, Next re-runs the server `instrumentation.ts` hook on every HMR rebuild; the SDK's in-process `_coreState` guard does not survive module re-evaluation, so each rebuild previously constructed a fresh `AsyncLocalStorage` whose internal `async_hooks.init` callbacks fed Next's `app-page-turbo.runtime.dev.js` Map until V8's `2^24 − 1` cap was exceeded. Closes DISC-1310. The fix anchors a three-state record under `globalThis[Symbol.for("glasstrace.context-manager.installed")]` (`{ glasstraceContextManagerBrand: 1, manager: ContextManager | null }`) so the first successful registration is reused on every subsequent call within the V8 isolate while OTel's global slot still holds it. The cached record is validated against OTel's actual registered manager on every call: if another component has run `otelApi.context.disable()` or replaced the manager, the SDK re-registers (reusing the cached `AsyncLocalStorage`, never allocating a fresh one) instead of returning a stale outcome — restoring the recovery behavior of the previous implementation while preserving the DISC-1310 allocation guard. The `InstallationRecord` predicate validates the `manager` field against the full OTel `ContextManager` shape (`active`, `with`, `bind`, `enable`, `disable`); foreign squatters and corrupt records (e.g. `{ glasstraceContextManagerBrand: 1, manager: {} }`) are detected and overwritten rather than silently honored. The existing DISC-1183 context-propagation contract is preserved across all guard states. Per-isolate scope (`globalThis`); `node:worker_threads` and `node:vm` contexts get their own slot, which is the correct behavior. No public-API change.

## 1.1.3

### Patch Changes

- 625964d: Crash-consistency: atomic file writes now fsync the temp file and parent directory before/after rename, matching the SDK 2.0 atomic-write protocol (`docs/component-designs/sdk-2.0.md` §4.3). Closes the durability gap that allowed DISC-494 (anon-key unlinked silently on re-init) under crash interleavings. The new internal helper at `packages/sdk/src/atomic-write.ts` exposes `atomicWriteFile` (async) and `atomicWriteFileSync` (sync, for the runtime-state writer that runs from a signal handler); all five atomic-write call sites (`mcp-runtime.ts`, `init-client.ts`, `runtime-state.ts`, `cli/discovery-file.ts`, `cli/uninit.ts`) now route through the helper. Parent-directory fsync swallows `EISDIR`/`EINVAL`/`EPERM`/`ENOTSUP` so platforms without directory-fsync semantics (Windows / NTFS) continue to work; genuine I/O errors still propagate. No public-API change.

## 1.1.2

### Patch Changes

- a80d91d: Internal: drop transitional MCP credential helper re-export shims now that Wave A stable has shipped. `cli/scaffolder.ts` and `cli/constants.ts` no longer re-export `readEnvLocalApiKey`, `isDevApiKey`, `mcpConfigMatches`, `identityFingerprint`, or `MCP_ENDPOINT` from `mcp-runtime.ts`; in-tree CLI callers now import these symbols directly from the runtime module. No public-API change — the shimmed paths were never exposed by the `exports` map.
- 52b8dc8: Docs: align README to published 1.x status; document validation linking workflow; add F003 strict-gate policy notes (SDK-033).

  `packages/sdk/README.md`'s top banner replaces the stale "Pre-release —
  not yet published to npm" notice with the install command and a link to
  the published package and `CHANGELOG.md`. The `/node` symbol matrix gains
  a "Why is X Node-only?" subsection explaining why the edge-bundle gate
  keeps a symbol on the Node-only side even when its `process` reach is
  wrapped in a `typeof` or `try`/`catch` guard, citing the F003 strict-gate
  policy decision (SDK-033).

  `CONTRIBUTING.md` adds a "Validating the SDK against a real consumer
  project" section that documents the `npm pack` + tarball workflow as
  the recommended way to validate a candidate build, with explicit notes
  on why `npm link` masks peer-resolution bugs and how to tear the
  validation down cleanly.

  `packages/sdk/scripts/check-edge-bundle.mjs` gains a brief comment above
  `PROCESS_SENTINEL` recording the same strict-by-design policy so the
  rationale travels with the code, not just the docs.

  No runtime behavior change; package exports and types are unchanged.

- 16b5afe: Capture HTTP error response bodies when the account opts in.

  When the account-side `captureConfig.errorResponseBodies` flag is `true`
  and a span carries an HTTP status in `[400..599]`, the exporter now
  promotes the internal `glasstrace.internal.response_body` attribute to
  the public `glasstrace.error.response_body` attribute. The flag
  defaults to `false`, so capture is off unless the account has
  explicitly enabled it server-side.

  Before promotion, the body is sanitized to redact common secret
  patterns — Bearer tokens, JWT-shaped tokens, Glasstrace API keys
  (`gt_dev_*` / `gt_anon_*`), AWS access-key prefixes (`AKIA…` /
  `ASIA…`), and generic `apikey`/`secret`/`password`/`token` key-value
  pairs — and truncated to 4096 UTF-8 bytes with a `...[truncated]`
  marker appended when truncation fires. Truncation respects codepoint
  boundaries so multi-byte characters are never split mid-sequence.

  The previous Phase 1 passthrough lacked the status gate, the
  sanitization step, and bottomed out at a 500-character truncation; an
  adapter that mistakenly populated the internal attribute on a 200
  response could leak through. The status gate closes that path. No
  public API symbols are added.

  Closes DISC-1216.

## 1.1.1

### Patch Changes

- b26b19f: Refresh managed MCP config when a project transitions to an account credential.

  When a project moves from anon to account/dev-key (claim transition), the
  managed `.glasstrace/mcp.json` and per-agent MCP configs previously kept the
  unclaimed anon bearer. MCP queries stayed scoped to anon rows while ingestion
  wrote account-scoped traces, so traces visible in the dashboard returned no
  matches via MCP. The SDK now resolves the project's effective MCP credential
  (`.env.local` dev key → `.glasstrace/claimed-key` → `.glasstrace/anon_key`)
  and refreshes managed configs whenever the on-disk file is the SDK-shaped
  output for the current anon key. User-edited MCP config files are preserved.

  `glasstrace mcp add` detects credential drift via a versioned
  `mcp-connected` marker and re-registers when the marker no longer matches
  the resolver's effective credential. Vendor MCP CLI registration (Claude,
  Gemini) is now anon-only; dev keys fall through to the file-config path
  which writes `0o600` and never exposes the bearer in process arguments.
  Codex's `bearer_token_env_var = "GLASSTRACE_API_KEY"` pattern is
  preserved.

## 1.1.0

### Minor Changes

- 2bc645b: Widen `@prisma/instrumentation` peer range to include `^7.0.0`. The SDK runtime already tolerates any major version of `@prisma/instrumentation` because the only references are dynamic `tryImport("@prisma/instrumentation")` call sites in `packages/sdk/src/otel-config.ts`, each of which guards on the `PrismaInstrumentation` constructor being present before use. This change advertises existing compatibility so consumers on Prisma 7 can install `@glasstrace/sdk` without a peer-dep conflict. Closes DISC-1309.

### Patch Changes

- 72fb1be: chore: SDK hygiene pass — drop underscore-prefix on otel-config module state, pair proxy.ts with middleware.ts for Next 16+ captureCorrelationId recommendation
- d581b6f: Port the `verify:subpath` postbuild gate from a bash script to a cross-platform Node script. `npm run build` now succeeds on Windows without Git Bash or WSL. No runtime behavior change: the gate still runs two probes (`import("@glasstrace/sdk/node")` under ESM and `createRequire(...)("@glasstrace/sdk/node")` under CJS), still asserts a non-empty resolved module, and still emits the same `[verify-subpath] @glasstrace/sdk/node resolves under ESM and CJS` success banner. Failure messages gain a pointer at the `exports` map in `packages/sdk/package.json`. Internal tooling only — no public API surface change.

## 1.0.1

### Patch Changes

- ffa8f7a: Document `/node` surface with edge-compat JSDoc annotations. Every export reachable via `@glasstrace/sdk/node` now carries a `@remarks` block in its JSDoc explaining why it lives under the Node-only subpath — naming the specific Node dependency (`node:fs`, `@vercel/blob`, etc.) where one exists, or the cohesion reason for symbols that are pure on their own but belong alongside the Node-only upload / import-graph flows. README gains a symbol-level matrix of the 14 `/node` exports. A snapshot test enforces that every `/node` export carries the "Node-only." marker so new exports can't ship without documentation. No API surface change.

## 1.0.0

### Major Changes

- e40bfec: **Breaking.** Narrow the `@glasstrace/sdk` root barrel. Two independent
  removals land in this release:

  ### Node-only symbols moved to `@glasstrace/sdk/node`

  14 symbols whose transitive closure touches `fs`, `path`, or
  `@vercel/blob` now live only on the new `@glasstrace/sdk/node` subpath
  (wired by the companion SDK-030 changeset in this release). This keeps
  the root specifier edge-safe: importing from `@glasstrace/sdk` in a
  workerd / Vercel Edge bundle can no longer drag Node built-ins into the
  closure.

  Values (build-time source-map + import-graph helpers):

  - `discoverSourceMapFiles`
  - `collectSourceMaps`
  - `computeBuildHash`
  - `uploadSourceMaps`
  - `PRESIGNED_THRESHOLD_BYTES`
  - `uploadSourceMapsPresigned`
  - `uploadSourceMapsAuto`
  - `discoverTestFiles`
  - `extractImports`
  - `buildImportGraph`

  Types:

  - `SourceMapFileInfo`
  - `SourceMapEntry`
  - `BlobUploader`
  - `AutoUploadOptions`

  **Migration.** Move each import from `@glasstrace/sdk` to
  `@glasstrace/sdk/node`:

  ```ts
  // Before
  import { uploadSourceMapsAuto } from "@glasstrace/sdk";
  // After
  import { uploadSourceMapsAuto } from "@glasstrace/sdk/node";
  ```

  `withGlasstraceConfig` stays on the root specifier — it's the standard
  import site for `next.config.ts` and intentionally continues to work
  unchanged.

  ### `createDiscoveryHandler` removed (v1.0.0 deprecation followthrough)

  The runtime discovery handler and its supporting type were deprecated in
  `0.20.0` with a promise to remove them in `v1.0.0` (see
  `packages/sdk/README.md`). That promise is now kept:

  - `createDiscoveryHandler` (value)
  - `ClaimState` (type)

  Both are removed from the public API. The supported discovery contract
  is the static file `public/.well-known/glasstrace.json` (or
  `static/.well-known/glasstrace.json` on SvelteKit) written by
  `npx glasstrace init`; the browser extension reads that file
  directly. The SDK retains an internal runtime handler at
  `/__glasstrace/config` for backwards compatibility with older
  consumer integrations during local development. The internal handler
  is **not part of the supported discovery contract** — it is not
  documented for use, not covered by validation expectations, and may
  be removed in a future release without a deprecation cycle. External
  consumers who still invoke `createDiscoveryHandler` directly should
  run `npx glasstrace init` and rely on the static file; see the
  **Migration: removing the runtime discovery handler** section of
  `packages/sdk/README.md` for the full before/after.

  A snapshot test at `tests/unit/sdk/public-barrel.test.ts` guards the
  narrowed root surface against accidental re-addition.

### Minor Changes

- e40bfec: Add `@glasstrace/sdk/node` subpath export for Node-only build-time
  tooling. Pairs with the root-barrel narrowing in this release: the 10
  value + 4 type symbols removed from `@glasstrace/sdk` are now reachable
  under the new subpath.

  ```ts
  import { uploadSourceMapsAuto } from "@glasstrace/sdk/node";
  ```

  **Resolution shape** — the `./node` entry is a node-conditional export
  with a `default: null` edge-guard. Resolution outcomes:

  | Conditions                          | Resolves to                       |
  | ----------------------------------- | --------------------------------- |
  | `types`                             | `dist/node-subpath.d.ts`          |
  | `node + import`                     | `dist/node-subpath.js`            |
  | `node + require`                    | `dist/node-subpath.cjs`           |
  | non-Node (workerd, edge-light, ...) | `null` (clean resolution failure) |

  Types are hoisted to the top level of the `./node` entry so consumers
  on `moduleResolution: "bundler"` can see declarations; runtime
  resolution stays strictly Node-gated.

  A `postbuild` hook runs `scripts/verify-subpath-resolution.sh` to
  smoke-test both ESM (`import("@glasstrace/sdk/node")`) and CJS
  (`require("@glasstrace/sdk/node")`) against the emitted bundles. If the
  subpath stops resolving, CI fails before publish.

## 0.20.1

### Patch Changes

- f9ef5bc: Add internal `WELL_KNOWN_GLASSTRACE_PATH` constant in
  `packages/sdk/src/cli/discovery-file.ts`.

  The new constant is the RFC 8615 static discovery-file path
  (`.well-known/glasstrace.json`) served by `sdk init` under the
  framework-specific static root. It replaces two duplicated string
  literals in `relativeDiscoveryPath` and carries a `@drift-check`
  JSDoc anchor so a future maintenance pass can verify the path
  against the design doc and the RFC.

  The change is additive and internal. `cli/discovery-file` is not
  in this package's `exports` map, so the constant is not reachable
  by external consumers and no published behavior changes.

  See `DRIFT.md` and `../glasstrace-product/docs/component-designs/sdk-2.0.md`
  §7.1 (Static discovery file).

## 0.20.0

### Minor Changes

- e6df410: Write a static discovery file at `public/.well-known/glasstrace.json`
  during `glasstrace init` so the Glasstrace browser extension can locate
  the project's anonymous key without a runtime HTTP handler. SvelteKit
  projects receive the file at `static/.well-known/glasstrace.json`.
  Re-running `init` preserves any user-added fields and only rewrites when
  the on-disk anonymous key has changed.

  `glasstrace uninit` now removes the discovery file and, when empty, the
  enclosing `.well-known/` directory. Sibling content (for example a
  project-maintained `security.txt`) is never touched.

  `createDiscoveryHandler` is deprecated and prints a one-time warning on
  first invocation. It remains functional for this release line and will
  be removed in `v1.0.0`. Users who wired the handler into `middleware.ts`
  (Next.js 15 and earlier) or `proxy.ts` (Next.js 16 and later) can remove
  it entirely after running `init` to generate the static file; the README
  contains before/after migration snippets for both cases.

## 0.19.0

### Patch Changes

- b204dbf: Re-export `deriveSessionId` from `@glasstrace/protocol` (DISC-1266). The SDK's session ID derivation now runs through a pure-JavaScript SHA-256 implementation, so CJS, ESM, browser, and Edge runtimes all produce the same `SessionId` for the same inputs. Node CJS session IDs are unchanged; Node ESM and browser/Edge runtimes that previously fell back to a non-SHA-256 hash now produce the contract-defined SHA-256 value.

## 0.18.0

### Minor Changes

- c4980aa: Coexistence-aware signal handler: always installed, re-raises only when not in coexistence mode (DISC-1265). Scenario B state is set synchronously before handler installation so signals arriving in the async setup window do not race against an existing provider's flush. Scenario B users now receive heartbeat telemetry on exit.

## 0.17.3

### Patch Changes

- 3827c9b: Register a lifecycle shutdown hook on the @vercel/otel path to flush buffered spans on SIGTERM (DISC-1263). @vercel/otel does not self-flush on process exit; this hook closes the gap.

## 0.17.2

### Patch Changes

- f0ecf07: Remove `apiKey` from outbound request bodies — credentials are sent exclusively via the `Authorization: Bearer` header (DISC-782, DISC-1156). Adds a dedicated regression test suite and a security note in the package README.
- a952a5c: SDK hygiene: fix nested-catch double-counting of recordInitFailure (DISC-1121), codify health-report invariant (DISC-1123), fix stale MCP tool count in generateInfoSection (DISC-1222).
- de523ca: Update `@vercel/otel` peer dependency range to `^2.0.0` (DISC-1264).

  The previous peer range of `^1.0.0` was effectively broken: `@vercel/otel@1.x`
  requires `@opentelemetry/sdk-trace-base@<2.0.0`, but `@glasstrace/sdk` depends
  on `@opentelemetry/sdk-trace-base@^2.6.1`, making joint installation impossible
  (ERESOLVE). The updated range reflects the version the SDK actually supports and
  eliminates the spurious `unmet peer` warning for users on `@vercel/otel@2.x`.

## 0.17.1

### Patch Changes

- 7ff75b0: Add `./package.json` to both packages' `exports` maps so tooling and smoke tests can read installed versions via `require('@glasstrace/<pkg>/package.json')` without hitting `ERR_PACKAGE_PATH_NOT_EXPORTED` on Node 22+. Also fixes the post-publish smoke workflow to read `node_modules/@glasstrace/<pkg>/package.json` via `fs.readFileSync` so it works against already-published versions that do NOT have `./package.json` in their exports map.

## 0.17.0

### Minor Changes

- 1da83f7: Add Next.js Server Action detection and extension-correlation support
  (DISC-1253). The enriching exporter now sets
  `glasstrace.next.action.detected = true` on spans where a POST targets
  a page route (not `/api/*`, not `/_next/*`) — the same post-hoc
  pattern used for tRPC procedure extraction. A new public helper
  `captureCorrelationId(req)` reads the `x-gt-cid` header and materializes
  it as `glasstrace.correlation.id` on the active span, enabling
  correlation with Glasstrace browser extension data; call it from a
  Next.js `middleware.ts` or a custom server request hook. When a
  Server Action trace is detected without a correlation ID, a one-time
  stderr nudge recommends installing the browser extension; silence it
  with `GLASSTRACE_SUPPRESS_ACTION_NUDGE=1`. `@glasstrace/protocol`
  exports a new `NEXT_ACTION_DETECTED` attribute name.

## 0.16.0

### Minor Changes

- 5586a4f: Detect `src/` layout and merge into existing `instrumentation.ts` instead of overwriting (DISC-493 Issue 1). Fixes the silent-init failure on every Next.js app using `src/` as its root layout.
- c9e95b9: Auto-attach the Glasstrace span processor onto an existing OTel provider (Next.js 16 production, Sentry, Datadog, New Relic) instead of silently giving up. Closes the "no traces exported" black hole documented in DISC-493 Issues 2 and 4. Auto-attach reuses the `createGlasstraceSpanProcessor()` primitive, so the automatic and manual integration paths share identical wiring and idempotence via the branded exporter symbol.
- e62c206: Bypass Next.js 16's patched `fetch` for `/v1/sdk/init` using `node:https`
  directly, and verify anon-key registration during CLI `glasstrace init`
  instead of relying on runtime fire-and-forget. Resolves the silent
  init-hang (DISC-493 Issue 3) and the silently-unlinked anon-key
  (DISC-494) in one PR.

  - The SDK now issues its init request via `node:https`, with a 10-second
    per-request timeout, 500 ms + 1500 ms retry backoff on transport
    failures, and a 20-second total deadline. Server HTTP 4xx/5xx
    responses are surfaced immediately and never retried.
  - `glasstrace init` now blocks on a verification call before reporting
    success. On failure it exits with code `2` and an error message
    distinguishing three classes: `fetch failed`, `server rejected the
key`, and `server returned malformed response`.
  - No new runtime dependencies — `node:https` is a Node.js core module
    and adds zero bundle weight to the tsup-inlined SDK.
  - Set `GLASSTRACE_SKIP_INIT_VERIFY=1` to skip verification for offline
    installs. CI mode skips verification automatically.

### Patch Changes

- 0a396b5: Fix `next dev --webpack` compatibility with `@glasstrace/sdk`. DISC-1257
  is a four-part fix that spans the SDK's emit pipeline and the Next.js
  config wrapper:

  - `shims: false` in tsup. The stock `esm_shims.js` injected static
    top-level `import path from "path"` and `import { fileURLToPath } from
"url"` pairs into every emitted ESM chunk to synthesize `__dirname` /
    `__filename`. The SDK source does not reference any of those symbols,
    so the shim was dead weight and now disabled.
  - `removeNodeProtocol: false` in tsup. tsup was rewriting SDK-source
    `node:fs/promises` / `node:path` / `node:crypto` imports to the
    unprefixed form before emit. Node 14.18+/16+ supports the `node:`
    prefix natively, and the SDK already requires Node >= 20, so
    preserving the prefix verbatim is a straight improvement.
  - `withGlasstraceConfig()` pushes `@glasstrace/sdk` onto
    `serverExternalPackages` (Next 15+). Next loads the SDK via Node's
    `require()` on the RSC and Route Handler paths instead of routing it
    through webpack — the same pattern Prisma, `@vercel/otel`, Sentry,
    `sharp`, and `bcrypt` ship with. The Next 14 legacy
    `experimental.serverComponentsExternalPackages` key is no longer
    written because Next 16 logs a deprecation warning for it.
  - `withGlasstraceConfig()` now also installs a webpack `externals`
    function that rewrites every Node.js built-in import — both `node:*`
    and the bare form (`zlib`, `stream`, etc.) used by transitive
    dependencies like `@opentelemetry/otlp-exporter-base` — into a
    runtime `commonjs` require. Membership is decided by Node's own
    `isBuiltin` helper so the list stays version-correct automatically.
    `serverExternalPackages` alone does not reach the
    `next dev --webpack` instrumentation path (vercel/next.js#58003,
    #28774); the externals function is what actually unblocks the dev
    server on webpack, and it's harmless on production webpack builds
    and Turbopack (which resolves Node built-ins natively and ignores
    this field).

  Production builds (Turbopack or webpack) were unaffected. Teams running
  `next dev --webpack` with `@glasstrace/sdk` are now unblocked
  (DISC-1257).

## 0.15.1

### Patch Changes

- 5f8a374: Migrate heartbeat shutdown handlers onto the lifecycle coordinator so OTel flush and final health-report fire in a deterministic order.

## 0.15.0

### Minor Changes

- 51b4295: Harden `sdk init` / `sdk uninit` lifecycle across six install/uninstall
  scenarios: uninit-while-running (shutdown marker file), re-install
  preservation (anon key, config cache, and diff-aware MCP prompts), npm
  uninstall warning (`preuninstall` script), partial-uninit validation
  (`sdk init --validate`), atomic config writes, and dev-key preservation
  in both `.env.local` and the uninit confirmation flow (DISC-1247,
  DISC-1251).

### Patch Changes

- 6dcef64: Register SIGTERM/SIGINT handlers earlier so spans are not lost when a signal arrives during OTel setup (DISC-1249).

  Signal handlers are now installed synchronously inside `registerGlasstrace()` (after the production-disabled check and the synchronous OTel provider probe), rather than at the end of the async `configureOtel()` chain. This closes a timing window where a SIGTERM / SIGINT received during the `@vercel/otel` probe or provider registration would be delivered with no handler attached, silently dropping buffered spans. Handlers are installed only when this SDK will own the provider (Scenario A); in coexistence mode the existing provider continues to own signal shutdown unchanged.

## 0.14.2

### Patch Changes

- 9e4935e: Fix Next.js 16 compatibility in `withGlasstraceConfig` and the source-map uploader

  - **DISC-1255** — `@vercel/blob/client` is now imported via the `Function("id", "return import(id)")` dynamic-import evasion helper. This prevents webpack, tsup, esbuild, and rollup from resolving the specifier at build time, which previously broke every webpack-based Next.js consumer that did not have the optional `@vercel/blob` peer dependency installed.
  - **DISC-1256** — `withGlasstraceConfig<T extends object>(config: T): T` now accepts Next's actual `NextConfig` interface (which has no string index signature) and preserves the caller's config subtype, resolving the Next 16 type-check error. The wrapper also seeds an empty `turbopack: {}` when none is provided so `next build` (which defaults to Turbopack in Next 16) no longer rejects the injected `webpack` config. A one-time warning explains that source-map upload currently runs only under `next build --webpack`; Turbopack parity is a follow-up.

  CI now guards against regressions with (a) a grep check against the shipped SDK bundle for literal `import("@vercel/blob/client")` / `import("@vercel/otel")` calls, and (b) a `next-compat` job that scaffolds a bare Next.js app and runs both `next build` and `next build --webpack`.

## 0.14.1

### Patch Changes

- 671e360: Re-release 0.14.0 content as 0.14.1 on the `latest` dist-tag.

  Version 0.14.0 was built correctly from `main` but published under the
  `canary` dist-tag due to a workflow misuse (a canary dispatch ran after
  the version PR had already consumed the changesets, causing the empty
  snapshot to publish the current stable semver as a canary). The canary
  publish path in `release.yml` now fails fast when no changesets are
  present, preventing this class of mis-tag going forward.

## 0.14.0

### Minor Changes

- 4f4abe8: Add OTel provider coexistence, lifecycle state machine, and public APIs

  - OTel coexistence: auto-attach to existing providers (Sentry, Datadog) via tiered detection (DISC-1202)
  - New public API: createGlasstraceSpanProcessor() for clean manual Sentry integration
  - New public APIs: isReady(), waitForReady(), getStatus() for lifecycle state querying
  - Lifecycle state machine with validated transitions across core, auth, and OTel layers
  - Unified shutdown coordinator with signal + beforeExit triggers
  - Runtime state bridge (.glasstrace/runtime-state.json) for CLI diagnostics
  - tRPC procedure name extraction from URL path (DISC-1215)
  - Error response body config scaffolding (DISC-1216 Phase 1)
  - Prisma instrumentation on bare OTel path (DISC-1223)
  - Remove API key from request bodies — credentials sent exclusively via Authorization header (DISC-1017)
  - Symbol.for('glasstrace.exporter') branding for cross-bundle processor detection

## 0.13.6

### Patch Changes

- 06ed0b5: Detect error traces via exception events when span status is UNSET — the Next.js dev server timing race can export spans before closeSpanWithError runs, but exception events from recordException are still present (DISC-1204).

## 0.13.5

### Patch Changes

- 0280d36: Fix context manager race condition — use static import of AsyncLocalStorage instead of async dynamic import that resolved after installContextManager() was called (DISC-1183).

## 0.13.4

### Patch Changes

- 84eb43e: Fix ESM context manager installation — use `createRequire` from `node:module` instead of `Function("require")` which fails in ESM global scope (DISC-1183).

## 0.13.3

### Patch Changes

- 1fa0fc8: Fix context manager timing — register AsyncLocalStorage context manager synchronously in registerGlasstrace() before configureOtel() runs, so Next.js spans created during async OTel setup inherit trace context (DISC-1183).

## 0.13.2

### Patch Changes

- b0b9e37: Fix trace context propagation — switch from BasicTracerProvider to NodeTracerProvider so spans from the same HTTP request share a traceId and have proper parent-child relationships (DISC-1183).

## 0.13.1

### Patch Changes

- 29b8d80: Add per-span trace context diagnostics in verbose mode for traceId/parentSpanId propagation analysis.

## 0.13.0

### Minor Changes

- 4f0798e: Add `glasstrace status` CLI command for machine-readable SDK configuration state (DISC-1179). Reports whether the SDK is installed, initialized, and fully configured — designed for AI agents to determine what action to take.

## 0.12.6

### Patch Changes

- fd22187: Remove DISC-1133 diagnostic logging — investigation confirmed the trace drop issue is backend-side (DISC-1157), not SDK-side.

## 0.12.5

### Patch Changes

- 570add7: Fix error status code inference for Next.js dev server timing race (DISC-1134) and add trace pipeline diagnostics in verbose mode for DISC-1133 investigation.

## 0.12.4

### Patch Changes

- ee4c771: Add periodic health heartbeat that reports SDK health metrics to the backend every 5 minutes after successful init. Includes exponential backoff with jitter on rate-limit (429) responses, shutdown health report on SIGTERM/SIGINT, and concurrent tick protection. Also fixes nested catch double-count (DISC-1121), documents ZodError double-reporting trade-off (DISC-1120), and corrects JSDoc on span export counting (DISC-1118).

## 0.12.3

### Patch Changes

- 82d2fa6: Fix trace capture rate by reducing BatchSpanProcessor flush interval from 5 seconds to 1 second, adding export failure logging so OTLP errors are no longer silent, fixing forceFlush to drain pending span batches, and enabling OTel diagnostic logging in verbose mode.

## 0.12.2

### Patch Changes

- fce4407: Add SDK health report collection to init call. Each `POST /v1/sdk/init` request now includes span export/drop counts, init failure counts, and config staleness metrics, enabling the backend to surface SDK health issues in the dashboard.

## 0.12.1

### Patch Changes

- f075582: Source map uploads now stream files individually instead of loading all into memory simultaneously, reducing peak memory usage for large projects.

## 0.12.0

### Minor Changes

- 879c6ef: SDK runtime modules no longer crash in non-Node environments. Session ID derivation falls back to a deterministic hash when node:crypto is unavailable. File-system operations use dynamic imports to avoid bundler failures.

### Patch Changes

- 005db52: Init now automatically rolls back completed scaffolding steps when a later step fails, preventing half-configured projects.

## 0.11.0

### Patch Changes

- 3e0e551: Discovery endpoint now includes `claimed: true` when the anonymous key has been linked to an account.

## 0.10.0

### Minor Changes

- 65a3004: SDK now gracefully handles non-Node.js environments (Edge Runtime, Cloudflare Workers) by disabling instrumentation with a clear warning instead of crashing on missing built-in module imports.

### Patch Changes

- a2a8f3e: Uninit now correctly handles next.config expressions containing parentheses or braces inside string literals and comments. Windsurf global config modifications now show the full file path in output.

## 0.9.1

### Patch Changes

- 766acd1: Added `sideEffects` field to package.json to enable bundler tree-shaking of unused exports.
- 83f7904: Fixed race condition in anonymous key creation where concurrent cold starts could end up with different keys.
- 37f5358: MCP connection nudge now fires on the first captured console.error, not just on explicit captureError() calls.

## 0.9.0

### Minor Changes

- a870032: Added `npx @glasstrace/sdk uninit` command that cleanly reverses all init artifacts. Supports `--dry-run` to preview changes.
- 5707f7c: Init now detects monorepo roots and automatically finds the Next.js app to scaffold into. Supports pnpm workspaces, npm workspaces, Turborepo, and Lerna monorepos.

## 0.8.0

### Minor Changes

- ad5e5e2: Init now injects registerGlasstrace() into existing instrumentation.ts files instead of skipping them. Projects with pre-existing Prisma, Sentry, or other instrumentation no longer need to manually add the Glasstrace registration call.

## 0.7.3

### Patch Changes

- 937d941: Fix first-run MCP setup by generating the anonymous key during init instead of requiring a separate dev server start, and guard against empty next.config files producing misleading "already wrapped" messages

## 0.7.2

### Patch Changes

- 6659716: Add error.stack to captureError, fix sideEffects field, improve documentation, and refactor internals

## 0.7.1

### Patch Changes

- 811cf91: Prevent API key exposure in claim result logging — keys are now written to .env.local instead of stderr

## 0.7.0

### Minor Changes

- d305b68: Add presigned source map upload for builds exceeding Vercel's 4.5MB serverless body limit

## 0.6.0

### Minor Changes

- 6329f5c: Handle account claim transitions in SDK init — automatically logs migration instructions when an anonymous key is linked to an account

## 0.4.2

### Patch Changes

- 945d2ad: Fix TOCTOU race in anonymous key generation and harden span attribute type guards

## 0.4.1

### Patch Changes

- 57586c6: Fix CodeQL ReDoS patterns in source-map-uploader and import-graph; wire first-error MCP nudge into captureError

## 0.4.0

### Minor Changes

- 1ab7ba3: Add `glasstrace mcp add` command for explicit MCP server registration with AI coding agents

## 0.3.0

### Minor Changes

- eba313a: Add MCP auto-configuration to `glasstrace init` — automatically detects AI coding agents and writes native MCP config files

## 0.2.3

### Patch Changes

- bcbb81a: Bundle OpenTelemetry packages (@opentelemetry/api, @opentelemetry/sdk-trace-base,
  @opentelemetry/exporter-trace-otlp-http) into the SDK so traces flow to the backend
  immediately after installation. No additional packages required. @opentelemetry/api
  is kept as an optional peer dependency for version compatibility with existing OTel
  installations.

## 0.2.2

### Patch Changes

- 17fa6ae: Treat empty-string GLASSTRACE_API_KEY as unset so the anonymous flow activates correctly after glasstrace init. The CLI now writes the API key as a comment in .env.local and clarifies that anonymous mode works by default.

## 0.2.1

### Patch Changes

- 243e2c1: Bundle @glasstrace/protocol and zod into the SDK so the package has zero mandatory dependencies. Consumers only need `npm install @glasstrace/sdk` plus their chosen OTel packages (all optional peer dependencies). Works with npm, pnpm, yarn, and Bun out of the box.

## 0.2.0

### Minor Changes

- 818cb18: Add opt-in console error capture and manual captureError API:

  - New `consoleErrors` field in CaptureConfig (default: false). When enabled, console.error and console.warn calls are recorded as span events on the active OTel span.
  - New `captureError(error)` function for manual error reporting, works regardless of consoleErrors config.
  - SDK's own log messages (prefixed with "[glasstrace]") are never captured.

- d4587e8: Initial release of the Glasstrace SDK and protocol packages.

  - `@glasstrace/protocol`: Shared types and wire format schemas (branded IDs, configuration, SDK init response, discovery, source map upload)
  - `@glasstrace/sdk`: Server-side debugging SDK for AI coding agents (OpenTelemetry instrumentation, span enrichment, anonymous key management, CLI scaffolder, Drizzle adapter)

- f2a551d: Harden OTel configuration for production reliability:

  - Switch from SimpleSpanProcessor to BatchSpanProcessor for OTLP exports, preventing event loop blocking on every span.end() call. SimpleSpanProcessor is retained only for the ConsoleSpanExporter debug fallback.
  - Stop silently overwriting existing OTel TracerProviders. If another tracing tool (Datadog, Sentry, New Relic) has already registered a provider, Glasstrace now skips registration and logs instructions for coexistence.
  - Register SIGTERM/SIGINT shutdown hooks to flush in-flight spans on process exit, preventing trace loss during graceful shutdowns.

### Patch Changes

- de777d0: Fix exporter resilience issues that could cause trace loss or stale authentication:

  - Defer span enrichment to flush time so buffered spans get session IDs computed with the resolved API key instead of the "pending" placeholder.
  - Close the buffer/flush race window by re-checking the key state after buffering.
  - Recreate the OTLP delegate exporter when the API key changes, supporting key rotation without restart.

- 28b35d7: Consume HTTP response bodies on error paths to prevent connection pool leaks under sustained error conditions.
- Updated dependencies [818cb18]
- Updated dependencies [d4587e8]
  - @glasstrace/protocol@0.2.0
