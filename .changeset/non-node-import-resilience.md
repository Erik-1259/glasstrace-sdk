---
"@glasstrace/sdk": minor
---

SDK now gracefully handles non-Node.js environments (Edge Runtime, Cloudflare Workers) by disabling instrumentation with a clear warning instead of crashing on missing built-in module imports.
