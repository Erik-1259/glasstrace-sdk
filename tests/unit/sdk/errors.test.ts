import { describe, it, expect } from "vitest";
import { SdkError } from "../../../packages/sdk/src/errors.js";
import type { SdkDiagnosticCode } from "@glasstrace/protocol";

describe("SdkError", () => {
  it("extends Error", () => {
    const err = new SdkError("ingestion_unreachable", "cannot reach server");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SdkError);
  });

  it("has typed code field from SdkDiagnosticCode", () => {
    const err = new SdkError("ingestion_auth_failed", "bad key");
    expect(err.code).toBe("ingestion_auth_failed");
    expect(err.message).toBe("bad key");
  });

  it("supports all SdkDiagnosticCode values", () => {
    const codes: SdkDiagnosticCode[] = [
      "ingestion_unreachable",
      "ingestion_auth_failed",
      "ingestion_rate_limited",
      "config_sync_failed",
      "source_map_upload_failed",
    ];
    for (const code of codes) {
      const err = new SdkError(code, `test ${code}`);
      expect(err.code).toBe(code);
    }
  });

  it("supports optional cause for error chaining", () => {
    const cause = new Error("network timeout");
    const err = new SdkError("ingestion_unreachable", "cannot reach server", cause);
    expect(err.cause).toBe(cause);
  });

  it("cause is undefined when not provided", () => {
    const err = new SdkError("config_sync_failed", "sync failed");
    expect(err.cause).toBeUndefined();
  });

  it("name property is SdkError", () => {
    const err = new SdkError("ingestion_rate_limited", "rate limited");
    expect(err.name).toBe("SdkError");
  });

  it("preserves stack trace", () => {
    const err = new SdkError("source_map_upload_failed", "upload failed");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("SdkError");
  });
});
