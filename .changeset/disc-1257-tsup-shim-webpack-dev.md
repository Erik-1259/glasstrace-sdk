---
"@glasstrace/sdk": patch
---

Fix `next dev --webpack` compatibility with `@glasstrace/sdk`. DISC-1257
is a four-part fix that spans the SDK's emit pipeline and the Next.js
config wrapper:

- `shims: false` in tsup. The stock `esm_shims.js` injected static
  top-level `import path from "path"` and `import { fileURLToPath } from
  "url"` pairs into every emitted ESM chunk to synthesize `__dirname` /
  `__filename`. The SDK source does not reference any of those symbols,
  so the shim was dead weight and now disabled.
- `removeNodeProtocol: false` in tsup. tsup was rewriting SDK-source
  `node:fs/promises` / `node:path` / `node:crypto` imports to the
  unprefixed form before emit. Node 14.18+/16+ supports the `node:`
  prefix natively, and the SDK already requires Node >= 20, so
  preserving the prefix verbatim is a straight improvement.
- `withGlasstraceConfig()` pushes `@glasstrace/sdk` onto
  `serverExternalPackages` (Next 15+). Next loads the SDK via Node's
  `require()` on the RSC and Route Handler paths instead of routing it
  through webpack — the same pattern Prisma, `@vercel/otel`, Sentry,
  `sharp`, and `bcrypt` ship with. The Next 14 legacy
  `experimental.serverComponentsExternalPackages` key is no longer
  written because Next 16 logs a deprecation warning for it.
- `withGlasstraceConfig()` now also installs a webpack `externals`
  function that rewrites every Node.js built-in import — both `node:*`
  and the bare form (`zlib`, `stream`, etc.) used by transitive
  dependencies like `@opentelemetry/otlp-exporter-base` — into a
  runtime `commonjs` require. Membership is decided by Node's own
  `isBuiltin` helper so the list stays version-correct automatically.
  `serverExternalPackages` alone does not reach the
  `next dev --webpack` instrumentation path (vercel/next.js#58003,
  #28774); the externals function is what actually unblocks the dev
  server on webpack, and it's harmless on production webpack builds
  and Turbopack (which resolves Node built-ins natively and ignores
  this field).

Production builds (Turbopack or webpack) were unaffected. Teams running
`next dev --webpack` with `@glasstrace/sdk` are now unblocked
(DISC-1257).
