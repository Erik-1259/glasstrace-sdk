---
"@glasstrace/sdk": minor
---

Harden `sdk init` / `sdk uninit` lifecycle across six install/uninstall
scenarios: uninit-while-running (shutdown marker file), re-install
preservation (anon key, config cache, and diff-aware MCP prompts), npm
uninstall warning (`preuninstall` script), partial-uninit validation
(`sdk init --validate`), atomic config writes, and dev-key preservation
in both `.env.local` and the uninit confirmation flow (DISC-1247,
DISC-1251).
