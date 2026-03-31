import type { SdkDiagnosticCode } from "@glasstrace/protocol";

/**
 * Internal SDK error class with a typed diagnostic code.
 * Caught at the boundary and converted to a log message + diagnostic entry.
 * Never thrown to the developer.
 */
export class SdkError extends Error {
  readonly code: SdkDiagnosticCode;

  constructor(code: SdkDiagnosticCode, message: string, cause?: Error) {
    super(message, { cause });
    this.name = "SdkError";
    this.code = code;
  }
}
