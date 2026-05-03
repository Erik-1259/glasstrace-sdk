---
"@glasstrace/sdk": patch
---

Docs: align README to published 1.x status; document validation linking workflow; add F003 strict-gate policy notes (SDK-033).

`packages/sdk/README.md`'s top banner replaces the stale "Pre-release —
not yet published to npm" notice with the install command and a link to
the published package and `CHANGELOG.md`. The `/node` symbol matrix gains
a "Why is X Node-only?" subsection explaining why the edge-bundle gate
keeps a symbol on the Node-only side even when its `process` reach is
wrapped in a `typeof` or `try`/`catch` guard, citing the F003 strict-gate
policy decision (SDK-033).

`CONTRIBUTING.md` adds a "Validating the SDK against a real consumer
project" section that documents the `npm pack` + tarball workflow as
the recommended way to validate a candidate build, with explicit notes
on why `npm link` masks peer-resolution bugs and how to tear the
validation down cleanly.

`packages/sdk/scripts/check-edge-bundle.mjs` gains a brief comment above
`PROCESS_SENTINEL` recording the same strict-by-design policy so the
rationale travels with the code, not just the docs.

No runtime behavior change; package exports and types are unchanged.
