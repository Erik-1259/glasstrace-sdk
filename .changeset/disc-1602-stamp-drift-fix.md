---
"@glasstrace/sdk": patch
---

fix(release): canary publish now bakes the canary version into the dist
bundle (DISC-1602)

The `release.yml` workflow previously ran `npm run build` BEFORE
`npx changeset version --snapshot canary`. Because tsup's
`define: { __SDK_VERSION__: pkg.version }` reads `package.json#version`
at build time, the built `dist/` shipped with the *pre-snapshot* stable
version baked in; `changeset publish --tag canary` then tagged the same
artifact under the new canary version, but the bundled
`__SDK_VERSION__` literal in CJS CLI bundles still encoded the stable.
Validation directly observed this on the SDK-050 canary
`0.0.0-canary-20260507174112`: `dist/cli/upgrade-instructions.cjs`
contained `"1.4.0"`, so the canary's `npx glasstrace upgrade-instructions`
stamped `<!-- glasstrace:mcp:start v=1.4.0 -->` rather than the
canary version.

Fix: reorder the canary publish steps so `Snapshot version` runs before
`Typecheck` / `Test` / `Build`. The `if: canary` gate is unchanged; for
stable, the snapshot step is skipped and the version that landed via
the merged Version Packages PR flows through the build correctly.

Defense-in-depth: a new postbuild gate
(`packages/sdk/scripts/check-sdk-version-stamp.mjs`) reads the current
`package.json#version` and asserts the literal appears in every CJS
CLI bundle. A future workflow reorder (or a tsup config drift that
removes the `define`) now fails CI before the publish step instead of
shipping a silently mis-stamped tarball.

No public API surface changes; consumers of stable
`@glasstrace/sdk@1.5.0` are unaffected. The bug only manifests on
canary publishes; subsequent canaries cut from the fixed workflow will
stamp correctly.
