---
"@glasstrace/sdk": patch
---

Fixed race condition in anonymous key creation where concurrent cold starts could end up with different keys.
