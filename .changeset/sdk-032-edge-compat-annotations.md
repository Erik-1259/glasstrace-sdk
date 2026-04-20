---
"@glasstrace/sdk": patch
---

Document `/node` surface with edge-compat JSDoc annotations. Every export reachable via `@glasstrace/sdk/node` now carries a `@remarks` block in its JSDoc explaining why it lives under the Node-only subpath — naming the specific Node dependency (`node:fs`, `@vercel/blob`, etc.) where one exists, or the cohesion reason for symbols that are pure on their own but belong alongside the Node-only upload / import-graph flows. README gains a symbol-level matrix of the 14 `/node` exports. A snapshot test enforces that every `/node` export carries the "Node-only." marker so new exports can't ship without documentation. No API surface change.
