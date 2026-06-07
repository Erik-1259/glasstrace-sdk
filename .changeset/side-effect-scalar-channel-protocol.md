---
"@glasstrace/protocol": minor
---

Add the value-fidelity scalar contract for side-effect evidence.

New exports describe a type-aware, off-summary scalar channel that
complements the existing categorical semantic-field channel:

- `SIDE_EFFECT_SCALAR_KEY_PATTERN` and `isSideEffectScalarKey` — camelCase
  keys ending in `Ms` / `Amount` / `Bytes` / `Ratio` / `Id` / `Value` /
  `Flag` (`Count` stays on the categorical channel).
- `SIDE_EFFECT_SCALAR_PREFIX` — the `glasstrace.side_effect.scalar.*`
  attribute namespace, and `SIDE_EFFECT_HASHED_ID_PREFIX` (`gthid_`) for
  pseudonymized identifiers.
- `MAX_SIDE_EFFECT_SCALARS_PER_OPERATION` — the per-operation scalar
  ceiling.
- Three additional omission reasons (`raw_timestamp`, `unhashed_id`,
  `non_finite`) and a `captureFidelity` (`strict` | `full`, default
  `strict`) posture on `CaptureConfig`.

All additions are backward-compatible.
