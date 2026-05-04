---
"@glasstrace/protocol": minor
---

Align `PresignedUploadResponseSchema` with the canonical backend wire schema (DISC-1544):

- Add the per-file `access: z.enum(["public"])` field that the backend has been emitting since DISC-756. The SDK protocol previously omitted it from the response shape, so external consumers using the protocol package as their canonical wire spec would silently drop it on parse. The Glasstrace SDK itself runs a `.parse()` against this schema during source-map upload; the backend has always set the field, so this change is runtime-compatible across all currently-deployed backends.
- Switch `expiresAt` from `z.number().int().positive()` to `z.number().int().nonnegative()` to match the backend's shared `TimestampSchema`. This is strictly more permissive (now accepts `0`); no SDK consumer relies on the prior strict-positive bound.

Categorized as a minor bump per existing precedent for additive schema changes (e.g., `errorResponseBodies` in 0.14.0, `claimed`/`accountHint` in 0.11.0). Backend integrations consuming `@glasstrace/protocol@0.20.0` need no source changes — the canonical wire shape is unchanged.
