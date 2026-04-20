---
"@glasstrace/sdk": patch
---

Port the `verify:subpath` postbuild gate from a bash script to a cross-platform Node script. `npm run build` now succeeds on Windows without Git Bash or WSL. No runtime behavior change: the gate still runs two probes (`import("@glasstrace/sdk/node")` under ESM and `createRequire(...)("@glasstrace/sdk/node")` under CJS), still asserts a non-empty resolved module, and still emits the same `[verify-subpath] @glasstrace/sdk/node resolves under ESM and CJS` success banner. Failure messages gain a pointer at the `exports` map in `packages/sdk/package.json`. Internal tooling only — no public API surface change.
