---
"@glasstrace/sdk": minor
---

Capture type-aware value-fidelity scalars on side-effect evidence.

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
