---
"@glasstrace/sdk": patch
---

Source map uploads now stream files individually instead of loading all into memory simultaneously, reducing peak memory usage for large projects.
