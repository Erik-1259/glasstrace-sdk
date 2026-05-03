---
"@glasstrace/sdk": patch
---

Crash-consistency: atomic file writes now fsync the temp file and parent directory before/after rename, matching the SDK 2.0 atomic-write protocol (`docs/component-designs/sdk-2.0.md` §4.3). Closes the durability gap that allowed DISC-494 (anon-key unlinked silently on re-init) under crash interleavings. The new internal helper at `packages/sdk/src/atomic-write.ts` exposes `atomicWriteFile` (async) and `atomicWriteFileSync` (sync, for the runtime-state writer that runs from a signal handler); all five atomic-write call sites (`mcp-runtime.ts`, `init-client.ts`, `runtime-state.ts`, `cli/discovery-file.ts`, `cli/uninit.ts`) now route through the helper. Parent-directory fsync swallows `EISDIR`/`EINVAL`/`EPERM`/`ENOTSUP` so platforms without directory-fsync semantics (Windows / NTFS) continue to work; genuine I/O errors still propagate. No public-API change.
