---
"@glasstrace/sdk": minor
---

Add `@glasstrace/sdk/node` subpath export for Node-only build-time
tooling. Pairs with the root-barrel narrowing in this release: the 10
value + 4 type symbols removed from `@glasstrace/sdk` are now reachable
under the new subpath.

```ts
import { uploadSourceMapsAuto } from "@glasstrace/sdk/node";
```

**Resolution shape** — the `./node` entry is a node-conditional export
with a `default: null` edge-guard. Resolution outcomes:

| Conditions | Resolves to |
|---|---|
| `types` | `dist/node-subpath.d.ts` |
| `node + import` | `dist/node-subpath.js` |
| `node + require` | `dist/node-subpath.cjs` |
| non-Node (workerd, edge-light, ...) | `null` (clean resolution failure) |

Types are hoisted to the top level of the `./node` entry so consumers
on `moduleResolution: "bundler"` can see declarations; runtime
resolution stays strictly Node-gated.

A `postbuild` hook runs `scripts/verify-subpath-resolution.sh` to
smoke-test both ESM (`import("@glasstrace/sdk/node")`) and CJS
(`require("@glasstrace/sdk/node")`) against the emitted bundles. If the
subpath stops resolving, CI fails before publish.
