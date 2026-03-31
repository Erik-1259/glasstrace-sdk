/**
 * SDK-specific enums.
 */

import { z } from "zod";

/** Diagnostic codes the SDK can report during health checks. */
export const SdkDiagnosticCodeSchema = z.enum([
  "ingestion_unreachable",
  "ingestion_auth_failed",
  "ingestion_rate_limited",
  "config_sync_failed",
  "source_map_upload_failed",
]);
export type SdkDiagnosticCode = z.infer<typeof SdkDiagnosticCodeSchema>;
