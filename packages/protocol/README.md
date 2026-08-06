# @glasstrace/protocol

Shared types and wire format schemas for the Glasstrace SDK.

This package defines the Zod schemas that form the public contract between
the Glasstrace SDK and the Glasstrace backend. Both the SDK (public) and
the backend (private) depend on this package.

## What's Inside

- **Branded ID types** -- `DevApiKey`, `AnonApiKey`, `SessionId`, `BuildHash`
- **Configuration schemas** -- `CaptureConfig`, `GlasstraceOptions`
- **Wire format schemas** -- `SdkInitResponse`, `DiscoveryResponse`, `SourceMapUploadResponse`
- **Constants** -- semantic attribute names; value enums for side-effect
  evidence and boundary-masked error scope (e.g. `BOUNDARY_MASKED_SCOPE_VALUES`);
  default capture config; source map upload limits
  (`MAX_SOURCE_MAP_FILE_PATH_LENGTH`, `MAX_SOURCE_MAP_FILE_SIZE`,
  `MAX_SOURCE_MAP_FILE_COUNT`)
- **Session ID derivation** -- `deriveSessionId()` produces the same 16-char
  hex `SessionId` the SDK uses, so independent clients (SDK, browser
  extension, tooling) agree on a session without coordination.
- **Result-evidence protocol (wire v1)** -- the provider-neutral grammar for
  bounded database-result evidence (see below).

## Result evidence (wire version 1)

Result evidence widens the side-effect scalar channel with bounded facts
about what a database operation returned. The grammar is provider-neutral —
no public symbol names an ORM, a model, or a concrete operation — and is
organized around three closed families:

| Family | Meaning |
|---|---|
| `1` | an aggregate count result |
| `2` | an aggregation bucket result |
| `3` | bounded row evidence |

Families `1` and `2` carry the family marker plus 1..16 flat scalar
attributes. Family `3` carries the marker, four operation cardinality
fields (`rows_total`, `row_cap`, `rows_selected`, `rows_emitted`),
contiguous per-row `candidates` / `emitted` metadata, and row scalars on
the `glasstrace.side_effect.scalar.r<n>.<baseKey>` key grammar (row index
`0..255`, base keys under the unchanged scalar-key rules). Fixed bounds:
at most 8 selected rows per operation, the existing shared 16-scalar
operation ceiling, and per-row counts of at most 256.

Key properties of the contract:

- **A family is a logical bundle.** OpenTelemetry attribute transport is
  best effort, so a receiver must validate completeness and drop the whole
  marked family when any part is missing, unknown, cross-family, or
  invalid. `validateResultEvidenceCompleteFamily()` implements that closed
  validation; nonthrowing builders and parsers
  (`buildResultEvidenceRowScalarKey`, `parseResultEvidenceRowScalarKey`,
  and the row-metadata equivalents) define the key grammars.
- **Producer/receiver ownership is explicit.** `rows_captured`, per-row
  `retained` metadata, and the receiver scalar manifest are receiver-owned:
  producer helpers cannot build them, and a producer bundle carrying them
  is invalid.
- **Values stay privacy-bounded.** Numeric scalars must be finite,
  safe-magnitude, and not timestamp-shaped
  (`isResultEvidenceTimestampShapedNumeric()` screens `*Ms` / `*Value`
  readings at the exported absolute thresholds by magnitude alone —
  fractional epoch-scale readings from high-resolution clocks are
  rejected just like integer ones); `*Flag`
  accepts native booleans and `*Id` accepts only the fixed-shape hashed
  `gthid_` token — both family-3-only. Raw identifiers, arbitrary
  strings, dates, and objects never enter the wire; the only admissible
  string value is that hashed token.
- **A marked span claims its whole scalar channel.** Every flat
  `glasstrace.side_effect.scalar.*` attribute on a span carrying a family
  marker is validated as family-1/2 evidence, and any flat scalar
  invalidates a family-3 bundle — so a producer must never co-locate
  result evidence with ordinary value-fidelity scalars on one span.
- **Capabilities are server-derived.** `CaptureConfigSchema` carries a
  strict optional `resultEvidenceCapabilities` envelope
  (`{ wireVersion: 1, aggregateScalars, boundedRows }`).
  `aggregateScalars` governs the flat families (`1` and `2`);
  `boundedRows` governs family `3`. Absence is valid and means neither
  capability is usable; unknown members, partial forms, and future wire
  versions fail validation rather than degrading. A structurally valid
  envelope is compatibility configuration only — it does not
  authenticate a server or a telemetry producer.

This package ships the grammar and validation only. Whether any SDK
adapter emits result evidence is governed separately by the SDK's own
capture configuration and releases.

## License

[MIT](./LICENSE)
