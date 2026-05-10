---
"@glasstrace/sdk": minor
---

Wave 18: align agent-instruction injection with the 2026 cross-tool
file-convention standard governed by the Agentic AI Foundation under
the Linux Foundation.

The SDK now writes the Glasstrace MCP managed section to:

- `AGENTS.md` (universal cross-tool destination — read by Cursor,
  Codex, Claude Code, GitHub Copilot, Devin, Windsurf, Gemini CLI)
- `CLAUDE.md` (Claude Code primary, unchanged)
- `GEMINI.md` (Gemini CLI primary — was previously not written at all)
- `.cursor/rules/glasstrace.mdc` (Cursor canonical 2026 `.mdc`
  workspace-rules destination with `alwaysApply: true` frontmatter)
- `.cursorrules` (Cursor transitional fallback — written
  unconditionally for mixed-version Cursor migration safety)
- `.windsurf/rules/glasstrace.md` (Windsurf workspace-rules directory)

Legacy single-file destinations (`codex.md`, `.windsurfrules`) are
no longer written to as primary — Codex no longer reads `codex.md`
by default and Windsurf has migrated away from `.windsurfrules`. The
legacy files are left untouched (their managed sections become stale
but free-text content is preserved); run
`npx glasstrace upgrade-instructions` to migrate.

The path-exists gate in `detect.ts` was dropped — the SDK now
creates canonical files when missing under the DISC-1592 marker
contract (idempotent in-place replacement on re-runs preserves the
soaked-in-production semantics). Multi-target write failures are
handled per-target with a fail-loud-per-target stderr warning (the
existing per-target write contract is broadened to all error
classes: EACCES, EROFS, ENOSPC, ENAMETOOLONG, ENOTDIR, EIO).

Backward-compat: existing users on legacy files retain access; the
legacy files are not deleted; the stale-section warning at SDK init
points the user at `npx glasstrace upgrade-instructions` for
migration. The `DetectedAgent` exported interface is unchanged
(option (c) sibling-helper design preserves the public API surface).
