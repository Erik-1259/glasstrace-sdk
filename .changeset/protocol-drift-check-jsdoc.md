---
"@glasstrace/protocol": patch
---

Ship `@drift-check` JSDoc tags on the Tier-1 protocol surfaces tagged
in SDK-031 (`DevApiKeySchema`, `AnonApiKeySchema`, `SessionIdSchema`,
`DiscoveryResponseSchema`, `GLASSTRACE_ATTRIBUTE_NAMES`,
`deriveSessionId`). TypeScript preserves these tags on the emitted
`dist/index.d.ts`, so the published type surface has changed since
`0.19.0` even though no runtime behavior did.

The SDK-031 PR (#177) only declared a patch on `@glasstrace/sdk`. The
repo's previous `.changeset/config.json` grouped `@glasstrace/protocol`
and `@glasstrace/sdk` under `linked`, but `linked` only syncs versions
among packages whose changesets **explicitly list them** — it does not
auto-add unmentioned packages to the bump group. The protocol `.d.ts`
change therefore shipped without a version bump. This changeset closes
that gap.
