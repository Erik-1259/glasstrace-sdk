---
"@glasstrace/protocol": minor
---
Export `deriveSessionId()` for client-side session ID derivation (DISC-1266). Enables consumers (e.g. the Glasstrace browser extension) to derive the same `SessionId` the SDK produces from the same inputs. The implementation is a pure-JavaScript SHA-256 so every runtime — Node CJS, Node ESM, modern browsers, Vercel Edge, Cloudflare Workers — produces a byte-identical result.
