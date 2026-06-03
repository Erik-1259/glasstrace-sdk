---
"@glasstrace/protocol": minor
"@glasstrace/sdk": minor
---

Extend the side-effect semantic field allowlist with three additive keys:
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
