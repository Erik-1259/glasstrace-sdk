---
"@glasstrace/sdk": patch
---

Fix Next.js 16 compatibility in `withGlasstraceConfig` and the source-map uploader

- **DISC-1255** — `@vercel/blob/client` is now imported via the `Function("id", "return import(id)")` dynamic-import evasion helper. This prevents webpack, tsup, esbuild, and rollup from resolving the specifier at build time, which previously broke every webpack-based Next.js consumer that did not have the optional `@vercel/blob` peer dependency installed.
- **DISC-1256** — `withGlasstraceConfig<T extends object>(config: T): T` now accepts Next's actual `NextConfig` interface (which has no string index signature) and preserves the caller's config subtype, resolving the Next 16 type-check error. The wrapper also seeds an empty `turbopack: {}` when none is provided so `next build` (which defaults to Turbopack in Next 16) no longer rejects the injected `webpack` config. A one-time warning explains that source-map upload currently runs only under `next build --webpack`; Turbopack parity is a follow-up.

CI now guards against regressions with (a) a grep check against the shipped SDK bundle for literal `import("@vercel/blob/client")` / `import("@vercel/otel")` calls, and (b) a `next-compat` job that scaffolds a bare Next.js app and runs both `next build` and `next build --webpack`.
