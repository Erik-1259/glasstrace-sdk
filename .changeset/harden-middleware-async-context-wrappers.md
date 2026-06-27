---
"@glasstrace/sdk": patch
---

Harden the request-middleware and async-causality wrappers:

- `tracedRequestMiddleware` and `withAsyncCausality` now reject whitespace-only
  span names (a name consisting only of spaces, tabs, or newlines was previously
  accepted).
- The span name and `attributes` option are captured when the wrapper is
  created; reassigning, adding, or removing a top-level `attributes` key (or
  changing `name`) on the passed object afterward no longer affects the emitted
  span. The attributes snapshot is shallow — in-place mutation of an
  array-valued attribute value is not isolated.
- The middleware request-path attribute is clamped to 2048 characters with a
  trailing ellipsis (surrogate-pair-safe) so a pathologically long URL cannot
  produce an oversized attribute value.

These are defensive correctness refinements; behavior for well-formed inputs is
unchanged from the previous release.
