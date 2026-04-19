---
"@glasstrace/sdk": minor
---

Write a static discovery file at `public/.well-known/glasstrace.json`
during `glasstrace init` so the Glasstrace browser extension can locate
the project's anonymous key without a runtime HTTP handler. SvelteKit
projects receive the file at `static/.well-known/glasstrace.json`.
Re-running `init` preserves any user-added fields and only rewrites when
the on-disk anonymous key has changed.

`glasstrace uninit` now removes the discovery file and, when empty, the
enclosing `.well-known/` directory. Sibling content (for example a
project-maintained `security.txt`) is never touched.

`createDiscoveryHandler` is deprecated and prints a one-time warning on
first invocation. It remains functional for this release line and will
be removed in `v1.0.0`. Users who wired the handler into `middleware.ts`
(Next.js 15 and earlier) or `proxy.ts` (Next.js 16 and later) can remove
it entirely after running `init` to generate the static file; the README
contains before/after migration snippets for both cases.
