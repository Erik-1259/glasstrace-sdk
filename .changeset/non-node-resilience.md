---
"@glasstrace/sdk": minor
---

SDK runtime modules no longer crash in non-Node environments. Session ID derivation falls back to a deterministic hash when node:crypto is unavailable. File-system operations use dynamic imports to avoid bundler failures.
