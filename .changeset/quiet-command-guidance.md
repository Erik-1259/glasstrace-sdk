---
"@glasstrace/sdk": patch
---

Update public CLI guidance and runtime hints to distinguish app-local
`glasstrace` execution from one-off registry execution. README examples now
prefer `npm exec -- glasstrace ...` or pnpm workspace-scoped commands after the
SDK is installed, and use `npx --yes --package @glasstrace/sdk glasstrace ...`
for first-time or one-off runs.
