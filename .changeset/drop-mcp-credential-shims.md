---
"@glasstrace/sdk": patch
---

Internal: drop transitional MCP credential helper re-export shims now that Wave A stable has shipped. `cli/scaffolder.ts` and `cli/constants.ts` no longer re-export `readEnvLocalApiKey`, `isDevApiKey`, `mcpConfigMatches`, `identityFingerprint`, or `MCP_ENDPOINT` from `mcp-runtime.ts`; in-tree CLI callers now import these symbols directly from the runtime module. No public-API change — the shimmed paths were never exposed by the `exports` map.
