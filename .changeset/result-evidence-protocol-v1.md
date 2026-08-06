---
"@glasstrace/protocol": minor
---

Add the provider-neutral result-evidence protocol (wire version 1): closed
family codes for count, aggregate, and bounded-row evidence; row-scalar and
row-metadata key grammars with nonthrowing builders and parsers; fixed
public bounds (8 selected rows per operation, row index 0..255, per-row
counts up to 256, the existing shared 16-scalar ceiling); a
timestamp-shaped numeric screen for `*Ms` / `*Value` scalars; and
`validateResultEvidenceCompleteFamily()`, the closed completeness
validation shared by producers and receivers. `CaptureConfigSchema` gains a
strict optional server-derived `resultEvidenceCapabilities` envelope
(`wireVersion: 1` plus independent `aggregateScalars` / `boundedRows`
booleans). An absent envelope is valid and simply leaves both capabilities
unusable; partial forms, unknown members, and future wire versions fail
validation. This release defines grammar and validation only — no SDK
adapter emits result evidence.
