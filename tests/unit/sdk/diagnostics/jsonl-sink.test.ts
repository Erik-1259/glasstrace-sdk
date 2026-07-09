import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSink } from "../../../../packages/sdk/src/diagnostics/jsonl-sink.js";
import type { DiagnosticRecord } from "../../../../packages/sdk/src/diagnostics/records.js";

const SUMMARY: DiagnosticRecord = {
  ev: "run-summary",
  t: 1,
  started: 1,
  ended: 1,
  unended: 0,
  droppedFromCap: 0,
  sweptAtTimeout: false,
  ranShutdown: true,
};
const START: DiagnosticRecord = {
  ev: "start",
  t: 2,
  traceId: "a",
  spanId: "b",
  parentSpanId: "0000000000000000",
  name: "x",
  kind: "SERVER",
};

describe("createJsonlSink", () => {
  it("appends bare, parseable JSON lines to a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-diag-"));
    try {
      const out = join(dir, "diag.jsonl");
      const sink = createJsonlSink(out);
      sink(SUMMARY);
      sink(START);
      const lines = readFileSync(out, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();
      expect(JSON.parse(lines[0])).toMatchObject({ ev: "run-summary" });
      expect(lines[0]).not.toContain("[span-diag]"); // file lines are bare JSON
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes [span-diag]-prefixed JSON to stdout when no path (and for an empty path)", () => {
    const chunks: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    try {
      createJsonlSink()(SUMMARY);
      createJsonlSink("")(SUMMARY);
    } finally {
      spy.mockRestore();
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`[span-diag] ${JSON.stringify(SUMMARY)}\n`);
  });

  it("swallows write failures — never throws into the host", () => {
    const sink = createJsonlSink("/no/such/dir/definitely/missing.jsonl");
    expect(() => sink(SUMMARY)).not.toThrow();
  });
});
