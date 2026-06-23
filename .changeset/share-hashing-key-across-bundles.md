---
"@glasstrace/sdk": patch
---

fix: share the per-account hashing key across bundled module instances

Under bundled development runtimes (Next.js / Turbopack `next dev`), the SDK can be
evaluated as more than one module copy in a single process. The per-account hashing
key used for full-fidelity pseudonymized `*Id` capture was held in module-local
state, so a copy that ran a Prisma projection without having applied the served
config could not read it — and full-fidelity `*Id` capture silently produced no
token.

The key now lives on the shared, process-global active-config record, behind a
closure accessor that keeps the raw bytes off the record's enumerable surface (so it
never appears in a serialized dump), reachable by every module copy. This is a
deliberate, scoped reduction of the key's previous in-isolate confinement —
appropriate for a development-time SDK, where the key is already in process memory —
and is required for full-fidelity `*Id` capture to work in bundled dev runtimes. The
single shared key follows last-writer-wins semantics, so no module copy can hash with
a stale or wrong-tenant key.
