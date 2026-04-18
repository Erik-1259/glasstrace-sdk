---
"@glasstrace/sdk": patch
---
Re-export `deriveSessionId` from `@glasstrace/protocol` (DISC-1266). The SDK's session ID derivation now runs through a pure-JavaScript SHA-256 implementation, so CJS, ESM, browser, and Edge runtimes all produce the same `SessionId` for the same inputs. Node CJS session IDs are unchanged; Node ESM and browser/Edge runtimes that previously fell back to a non-SHA-256 hash now produce the contract-defined SHA-256 value.
