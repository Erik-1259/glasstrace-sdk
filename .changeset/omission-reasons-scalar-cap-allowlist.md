---
"@glasstrace/protocol": minor
---

Split `unsupported_key` into two more specific side-effect omission
reasons. `SIDE_EFFECT_OMISSION_REASONS` (and the derived
`SideEffectOmissionReason` union) now also carry:

- `scalar_cap_exceeded` — a scalar value dropped because the
  per-operation scalar budget was already full (a cap-overflow drop,
  distinct from a value that is individually inadmissible).
- `allowlist_denied` — a value dropped by a default-deny allowlist gate
  (rejected because it was not explicitly permitted, distinct from a
  value that failed a key, shape, or length check).

Matching `glasstrace.side_effect.omitted.scalar_cap_exceeded` and
`glasstrace.side_effect.omitted.allowlist_denied` attribute names are
added to `GLASSTRACE_ATTRIBUTE_NAMES`. The addition is fully additive:
existing reasons and their wire strings are unchanged, so consumers that
do not yet recognize the new reasons continue to work.
