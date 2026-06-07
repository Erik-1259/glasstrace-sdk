---
"@glasstrace/sdk": minor
---

Capture boolean `*Holds` relations on side-effect evidence.

`recordSideEffect()` now accepts an optional `relations` map of
`boolean`s — producer-asserted invariants emitted on the categorical
field channel. Keys end in `Holds` (e.g. `timezonePreservedHolds`);
values are coerced to `"true"`/`"false"`. A non-`Holds` key, a
non-boolean value, or a key that also appears in `fields` (a collision —
`fields` wins) is dropped with the matching omission counter.

Two pure helpers compute the boolean from a comparison:

```ts
import { recordSideEffect, invariant, isNullInvariant } from "@glasstrace/sdk";

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
