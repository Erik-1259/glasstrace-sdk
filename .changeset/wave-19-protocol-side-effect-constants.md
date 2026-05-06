---
"@glasstrace/protocol": patch
---

feat(protocol): add side-effect evidence attribute name constants and value enums (SDK-049)

Adds `glasstrace.side_effect.*` attribute name constants to
`GLASSTRACE_ATTRIBUTE_NAMES` (4 top-level + 7 field + 7 omission =
18 entries) and exports the operation-kind, semantic-field-key,
omission-reason, operation-status, and operation-phase value tuples
with their derived TypeScript types. The capture-config schema gains
an additive `sideEffectEvidence` flag that defaults to `false`.
Aligns the SDK protocol with the glasstrace-product side-effect
evidence summary contract (SCHEMA-036, ING-023, MCP-024). Additive
only; existing constants and config defaults are untouched.
