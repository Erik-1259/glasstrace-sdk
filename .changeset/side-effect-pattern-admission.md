---
"@glasstrace/protocol": minor
"@glasstrace/sdk": minor
---

Replace the closed `SIDE_EFFECT_SEMANTIC_FIELD_KEYS` allowlist with
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
