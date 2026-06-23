---
"@glasstrace/protocol": patch
---

Add the boundary-masked scope attribute constant

Adds the `glasstrace.http.boundary_masked_scope` attribute constant, set
alongside `glasstrace.http.boundary_masked` during boundary-masked-error
promotion, with values `same_span` and `descendant`. Also refreshes the
`boundary_masked` attribute documentation to describe both the same-span and
descendant-aware scopes.
