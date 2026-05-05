---
"@glasstrace/sdk": patch
---

docs: clarify that `/.well-known/glasstrace.json` is the sole supported
discovery contract; runtime handler at `/__glasstrace/config` is internal
compatibility only (DISC-1417)

The README and CHANGELOG previously contained two statements that read as
contradictory: the SDK does not require `createDiscoveryHandler` to be
wired up, and the SDK installs an automatic runtime handler in anonymous
+ development mode. Both statements are individually true, but together
they failed to describe which surface external consumers should rely on.

The supported discovery contract is the static file
`public/.well-known/glasstrace.json` (or `static/.well-known/glasstrace.json`
on SvelteKit) written by `npx glasstrace init`; the browser extension reads
it directly. The internal runtime handler at `/__glasstrace/config` exists
solely as backwards compatibility for older consumer integrations during
local development. It is not documented for use, not covered by validation
expectations, and may be removed in a future release without a deprecation
cycle.

This release updates the README, CHANGELOG, the `glasstrace init` failure
warning, the protocol package's wire-format file comment, the `@internal`
JSDoc on `createDiscoveryHandler`, and the runtime install-site comments
in `register.ts` to all tell the same story. No public API changes; no
behavioral changes.
