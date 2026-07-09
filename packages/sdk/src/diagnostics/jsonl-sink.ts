/**
 * Node-only JSONL sink for diagnostic records. One JSON object per line, either
 * appended to a file or written to stdout with a `[span-diag]` prefix the sweep
 * harness parses. Best-effort: a write failure is swallowed and never throws
 * into the host request or affects span export.
 */

import { appendFileSync } from "node:fs";
import type { DiagnosticRecord } from "./records.js";

/**
 * Create a sink that serializes each record to one JSONL line. When `outPath` is
 * a non-empty string, lines are appended to that file as bare JSON; otherwise
 * they go to stdout prefixed with `[span-diag] `.
 */
export function createJsonlSink(outPath?: string): (record: DiagnosticRecord) => void {
  return (record) => {
    try {
      const line = JSON.stringify(record);
      if (outPath !== undefined && outPath.length > 0) {
        appendFileSync(outPath, line + "\n");
      } else {
        // Deliberately `process.stdout.write`, not `console.*`: console-capture.ts
        // patches `console.warn`/`console.error`, so a console line emitted while
        // a span is active would be re-ingested as a console event on the span
        // being described. Direct stdout bypasses that.
        process.stdout.write(`[span-diag] ${line}\n`);
      }
    } catch {
      // Best-effort diagnostic: an fs/stdout failure must never throw into the host.
    }
  };
}
