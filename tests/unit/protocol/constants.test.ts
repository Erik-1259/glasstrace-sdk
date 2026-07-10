import { describe, it, expect } from "vitest";
import {
  BOUNDARY_MASKED_SCOPE_VALUES,
  type BoundaryMaskedScope,
} from "../../../packages/protocol/src/index.js";

describe("BOUNDARY_MASKED_SCOPE_VALUES", () => {
  it("pins the wire value set the SDK emits and the backend reads", () => {
    // These are the two values the glasstrace.http.boundary_masked_scope
    // attribute can take. They are a wire contract shared with ingestion, so
    // this pin guards against a silent reorder/rename that would desync the
    // producer and consumer.
    expect([...BOUNDARY_MASKED_SCOPE_VALUES]).toEqual(["same_span", "descendant"]);
  });

  it("derives a literal-type union", () => {
    const sameSpan: BoundaryMaskedScope = "same_span";
    const descendant: BoundaryMaskedScope = "descendant";
    expect(BOUNDARY_MASKED_SCOPE_VALUES).toContain(sameSpan);
    expect(BOUNDARY_MASKED_SCOPE_VALUES).toContain(descendant);
  });
});
