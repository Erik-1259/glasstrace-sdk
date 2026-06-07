---
"@glasstrace/protocol": minor
---

Admit `*Holds` boolean-relation keys on the side-effect semantic-field
channel.

`SIDE_EFFECT_SEMANTIC_FIELD_OPEN_PATTERN` now accepts a fifth canonical
suffix, `Holds`, alongside `Class` / `Count` / `Kind` / `Role`
(`isSideEffectSemanticFieldKey` inherits it). A `*Holds` key carries a
producer-asserted boolean invariant (e.g. `timezonePreservedHolds`) as a
`"true"`/`"false"` string on the categorical field channel. Additive and
backward-compatible.
