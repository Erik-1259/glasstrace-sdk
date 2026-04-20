---
"@glasstrace/sdk": major
---

**Breaking.** Narrow the `@glasstrace/sdk` root barrel. Two independent
removals land in this release:

### Node-only symbols moved to `@glasstrace/sdk/node`

14 symbols whose transitive closure touches `fs`, `path`, or
`@vercel/blob` now live only on the new `@glasstrace/sdk/node` subpath
(wired by the companion SDK-030 changeset in this release). This keeps
the root specifier edge-safe: importing from `@glasstrace/sdk` in a
workerd / Vercel Edge bundle can no longer drag Node built-ins into the
closure.

Values (build-time source-map + import-graph helpers):

- `discoverSourceMapFiles`
- `collectSourceMaps`
- `computeBuildHash`
- `uploadSourceMaps`
- `PRESIGNED_THRESHOLD_BYTES`
- `uploadSourceMapsPresigned`
- `uploadSourceMapsAuto`
- `discoverTestFiles`
- `extractImports`
- `buildImportGraph`

Types:

- `SourceMapFileInfo`
- `SourceMapEntry`
- `BlobUploader`
- `AutoUploadOptions`

**Migration.** Move each import from `@glasstrace/sdk` to
`@glasstrace/sdk/node`:

```ts
// Before
import { uploadSourceMapsAuto } from "@glasstrace/sdk";
// After
import { uploadSourceMapsAuto } from "@glasstrace/sdk/node";
```

`withGlasstraceConfig` stays on the root specifier — it's the standard
import site for `next.config.ts` and intentionally continues to work
unchanged.

### `createDiscoveryHandler` removed (v1.0.0 deprecation followthrough)

The runtime discovery handler and its supporting type were deprecated in
`0.20.0` with a promise to remove them in `v1.0.0` (see
`packages/sdk/README.md`). That promise is now kept:

- `createDiscoveryHandler` (value)
- `ClaimState` (type)

Both are removed from the public API. The SDK continues to install the
handler automatically in anonymous + development mode — there is no
runtime capability loss. External consumers who still invoke
`createDiscoveryHandler` directly should run `npx glasstrace init` to
generate `public/.well-known/glasstrace.json` (or
`static/.well-known/glasstrace.json` on SvelteKit); the browser
extension reads that file directly and no longer needs the runtime
handler. See the **Migration: removing the runtime discovery handler**
section of `packages/sdk/README.md` for the full before/after.

A snapshot test at `tests/unit/sdk/public-barrel.test.ts` guards the
narrowed root surface against accidental re-addition.
