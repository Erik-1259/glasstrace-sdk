---
"@glasstrace/sdk": patch
---

Remove `apiKey` from outbound request bodies — credentials are sent exclusively via the `Authorization: Bearer` header (DISC-782, DISC-1156). Adds a dedicated regression test suite and a security note in the package README.
