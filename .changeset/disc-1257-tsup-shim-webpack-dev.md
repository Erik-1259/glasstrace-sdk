---
"@glasstrace/sdk": patch
---

Fix `next dev --webpack` compatibility. DISC-1257 is a three-part fix:
two tsup-output corrections (the SDK now emits clean, modern Node
bundles) plus a Next.js config-wrapper change that externalizes the SDK
on the instrumentation path. Without the third piece, webpack-dev-mode
still crashes on `node:child_process` because the dev bundler does not
handle any `node:` scheme inside a bundled package.

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
- `withGlasstraceConfig()` now pushes `@glasstrace/sdk` onto
  `serverExternalPackages` (Next 15+) and
  `experimental.serverComponentsExternalPackages` (Next 14). Next loads
  the SDK via Node's `require()` at runtime instead of routing it
  through webpack — the same pattern Prisma, `@vercel/otel`, Sentry,
  `sharp`, and `bcrypt` ship with. Dedupe is in place so existing user
  entries are preserved.

Production builds (Turbopack or webpack) were unaffected. Teams running
`next dev --webpack` with `@glasstrace/sdk` are now unblocked
(DISC-1257).
