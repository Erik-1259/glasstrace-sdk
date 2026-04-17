---
"@glasstrace/sdk": patch
---

Fix `next dev --webpack` compatibility. Two independent tsup defaults
produced unprefixed Node built-in specifiers in the shipped bundle that
Next.js' dev webpack path could not resolve, surfacing as `Module not
found` errors on every request to the dev server:

- The stock `esm_shims.js` injected static top-level
  `import path from "path"` and `import { fileURLToPath } from "url"`
  pairs into every emitted ESM chunk to synthesize
  `__dirname`/`__filename`. The SDK source does not reference any of
  those symbols, so the shim was dead weight and has been disabled
  (`shims: false`).
- `removeNodeProtocol: true` rewrote SDK-source `node:fs/promises` /
  `node:path` / `node:crypto` imports to the unprefixed form before
  emit. Node 14.18+/16+ supports the `node:` prefix natively, and the
  SDK already requires Node >= 20, so preserving the prefix verbatim
  is a straight improvement (`removeNodeProtocol: false`).

Production builds (Turbopack or webpack) were unaffected. Teams running
`next dev --webpack` with `@glasstrace/sdk` are now unblocked
(DISC-1257).
