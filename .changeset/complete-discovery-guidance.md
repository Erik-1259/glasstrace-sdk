---
"@glasstrace/sdk": patch
---

Prefer complete trace-discovery requests when the server supplies an unambiguous
match for the agent's selected action. Keep existing scope, evidence, permission,
and stop rules, with guarded legacy recovery when complete requests are absent
or unusable. Refresh existing project guidance with the app-local
`glasstrace upgrade-instructions` command after updating the SDK.
