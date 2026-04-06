---
"@glasstrace/sdk": patch
---

Treat empty-string GLASSTRACE_API_KEY as unset so the anonymous flow activates correctly after glasstrace init. The CLI now writes the API key as a comment in .env.local and clarifies that anonymous mode works by default.
