---
"@glasstrace/sdk": patch
---

Fix `next dev --webpack` by disabling tsup's ESM shim. The shim injected
static top-level `import path from "path"` and `import { fileURLToPath } from "url"`
pairs into every emitted ESM chunk to synthesize `__dirname`/`__filename`.
Next.js' dev webpack path does not externalize unprefixed Node built-ins,
so those imports surfaced as `Module not found` errors and every request
to the dev server returned 500. Production builds (Turbopack or webpack)
were unaffected. The SDK source does not reference `__dirname`,
`__filename`, or `import.meta.url`, so the shim was dead weight — dropping
it is a straight win that also shaves a few KB off the shipped bundle.
Teams running `next dev --webpack` with `@glasstrace/sdk` are now
unblocked (DISC-1257).
