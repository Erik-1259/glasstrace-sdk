---
"@glasstrace/sdk": patch
---

fix(test): bump non-blocking-init test threshold from 100ms to 500ms to tolerate CI scheduler jitter

The `register.test.ts` Checkpoint 5 "should return synchronously
without waiting for background work" test asserted
`registerGlasstrace()` returns within 100ms. CI cold-starts on the
stable-build runner intermittently exceeded this threshold (observed
at 121ms), causing spurious build failures. The actual non-blocking
behavior of `registerGlasstrace()` is unchanged — the API still
does NOT await background init work (OTel registration, key
resolution, init POST). Real background work is on the order of
seconds (network I/O); a synchronous return is on the order of
single-digit milliseconds even on slow agents. The 500ms threshold
is generous enough to tolerate scheduler jitter while still failing
fast if a regression makes the API await something it shouldn't.

Test-only change. No SDK runtime behavior change. Patch bump.
