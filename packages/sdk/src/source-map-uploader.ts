import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { sdkLog } from "./console-capture.js";
import {
  SourceMapUploadResponseSchema,
  type SourceMapUploadResponse,
  PresignedUploadResponseSchema,
  type PresignedUploadResponse,
  SourceMapManifestResponseSchema,
  type SourceMapManifestResponse,
} from "@glasstrace/protocol";

export interface SourceMapEntry {
  filePath: string;
  content: string;
}

/**
 * Recursively finds all .map files in the given build directory.
 * Returns relative paths and file contents.
 */
export async function collectSourceMaps(
  buildDir: string,
): Promise<SourceMapEntry[]> {
  const results: SourceMapEntry[] = [];

  try {
    await walkDir(buildDir, buildDir, results);
  } catch {
    // Directory doesn't exist or is unreadable — return empty
    return [];
  }

  return results;
}

async function walkDir(
  baseDir: string,
  currentDir: string,
  results: SourceMapEntry[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      await walkDir(baseDir, fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".map")) {
      try {
        const content = await fs.readFile(fullPath, "utf-8");
        const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
        // Strip the trailing .map extension so the key matches the compiled
        // JS path that the runtime uses for stack-frame lookups (e.g.
        // "static/chunks/main.js" instead of "static/chunks/main.js.map").
        const compiledPath = relativePath.replace(/\.map$/, "");
        results.push({ filePath: compiledPath, content });
      } catch {
        // Skip unreadable files
      }
    }
  }
}

/**
 * Computes a build hash for source map uploads.
 *
 * First tries `git rev-parse HEAD` to get the git commit SHA.
 * On failure, falls back to a deterministic content hash:
 * sort source map file paths alphabetically, concatenate each as
 * `{relativePath}\n{fileLength}\n{fileContent}`, then SHA-256 the result.
 */
export async function computeBuildHash(
  maps?: SourceMapEntry[],
): Promise<string> {
  // Try git first
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    if (sha) {
      return sha;
    }
  } catch {
    // Git not available, fall through to content hash
  }

  // Fallback: content-based hash
  const sortedMaps = [...(maps ?? [])].sort((a, b) =>
    a.filePath.localeCompare(b.filePath),
  );

  const hashInput = sortedMaps
    .map((m) => `${m.filePath}\n${m.content.length}\n${m.content}`)
    .join("");

  const hash = crypto.createHash("sha256").update(hashInput).digest("hex");
  return hash;
}

/**
 * Uploads source maps to the ingestion API.
 *
 * POSTs to `{endpoint}/v1/source-maps` with the API key, build hash,
 * and file entries. Validates the response against SourceMapUploadResponseSchema.
 */
export async function uploadSourceMaps(
  apiKey: string,
  endpoint: string,
  buildHash: string,
  maps: SourceMapEntry[],
): Promise<SourceMapUploadResponse> {
  const body = {
    apiKey,
    buildHash,
    files: maps.map((m) => ({
      filePath: m.filePath,
      sourceMap: m.content,
    })),
  };

  const baseUrl = stripTrailingSlashes(endpoint);
  const response = await fetch(`${baseUrl}/v1/source-maps`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Consume the response body to release the connection back to the pool.
    // Without this, the underlying TCP socket stays allocated until GC, which
    // causes connection pool exhaustion under sustained error conditions.
    // Wrapped in try-catch so a stream error doesn't mask the HTTP status error.
    try { await response.text(); } catch { /* body drain is best-effort */ }
    throw new Error(
      `Source map upload failed: ${String(response.status)} ${response.statusText}`,
    );
  }

  const json: unknown = await response.json();
  return SourceMapUploadResponseSchema.parse(json);
}

// ---------------------------------------------------------------------------
// Presigned source map upload (3-phase flow for large builds)
// ---------------------------------------------------------------------------

/** Builds at or above this byte size route to the presigned upload flow. */
export const PRESIGNED_THRESHOLD_BYTES = 4_500_000;

/** Signature for the blob upload function, injectable for testing. */
export type BlobUploader = (
  clientToken: string,
  pathname: string,
  content: string,
) => Promise<{ url: string; size: number }>;

/**
 * Strips trailing slashes from a URL string.
 * Uses an iterative approach to avoid regex (CodeQL js/polynomial-redos).
 */
function stripTrailingSlashes(url: string): string {
  let result = url;
  while (result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Phase 1: Request presigned upload tokens from the ingestion API.
 *
 * POSTs to `{endpoint}/v1/source-maps/presign` with the build hash and
 * file metadata. Returns presigned tokens for each file that the client
 * uses to upload directly to blob storage.
 */
export async function requestPresignedTokens(
  apiKey: string,
  endpoint: string,
  buildHash: string,
  files: Array<{ filePath: string; sizeBytes: number }>,
): Promise<PresignedUploadResponse> {
  const baseUrl = stripTrailingSlashes(endpoint);
  const response = await fetch(`${baseUrl}/v1/source-maps/presign`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ buildHash, files }),
  });

  if (!response.ok) {
    try { await response.text(); } catch { /* body drain is best-effort */ }
    throw new Error(
      `Presigned token request failed: ${String(response.status)} ${response.statusText}`,
    );
  }

  const json: unknown = await response.json();
  return PresignedUploadResponseSchema.parse(json);
}

/**
 * Phase 2: Upload a single source map to blob storage using a presigned token.
 *
 * Dynamically imports `@vercel/blob/client` to avoid bundling the dependency.
 * Throws a descriptive error if the package is not installed.
 */
export async function uploadToBlob(
  clientToken: string,
  pathname: string,
  content: string,
): Promise<{ url: string; size: number }> {
  let mod: { put: (pathname: string, body: Blob, options: { access: string; token: string }) => Promise<{ url: string }> };
  try {
    mod = await import("@vercel/blob/client") as typeof mod;
  } catch (err) {
    // Distinguish "not installed" from other import errors
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(
        "Presigned upload requires @vercel/blob. Install it: npm install @vercel/blob",
      );
    }
    throw err;
  }

  const result = await mod.put(pathname, new Blob([content]), {
    access: "public",
    token: clientToken,
  });

  return { url: result.url, size: Buffer.byteLength(content, "utf-8") };
}

/**
 * Phase 3: Submit the upload manifest to finalize a presigned upload.
 *
 * POSTs to `{endpoint}/v1/source-maps/manifest` with the upload ID,
 * build hash, and blob URLs for each uploaded file. The backend activates
 * the source maps for stack trace resolution.
 */
export async function submitManifest(
  apiKey: string,
  endpoint: string,
  uploadId: string,
  buildHash: string,
  files: Array<{ filePath: string; sizeBytes: number; blobUrl: string }>,
): Promise<SourceMapManifestResponse> {
  const baseUrl = stripTrailingSlashes(endpoint);
  const response = await fetch(`${baseUrl}/v1/source-maps/manifest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ uploadId, buildHash, files }),
  });

  if (!response.ok) {
    try { await response.text(); } catch { /* body drain is best-effort */ }
    throw new Error(
      `Source map manifest submission failed: ${String(response.status)} ${response.statusText}`,
    );
  }

  const json: unknown = await response.json();
  return SourceMapManifestResponseSchema.parse(json);
}

/**
 * Orchestrates the 3-phase presigned upload flow.
 *
 * 1. Requests presigned tokens for all source map files
 * 2. Uploads each file to blob storage with a concurrency limit of 5
 * 3. Submits the manifest to finalize the upload
 *
 * Accepts an optional `blobUploader` for test injection; defaults to
 * {@link uploadToBlob}.
 */
export async function uploadSourceMapsPresigned(
  apiKey: string,
  endpoint: string,
  buildHash: string,
  maps: SourceMapEntry[],
  blobUploader: BlobUploader = uploadToBlob,
): Promise<SourceMapManifestResponse> {
  if (maps.length === 0) {
    throw new Error("No source maps to upload");
  }

  // Phase 1: request presigned tokens
  const presigned = await requestPresignedTokens(apiKey, endpoint, buildHash,
    maps.map((m) => ({
      filePath: m.filePath,
      sizeBytes: Buffer.byteLength(m.content, "utf-8"),
    })),
  );

  // Build a lookup map for O(1) access by filePath
  const mapsByPath = new Map(maps.map((m) => [m.filePath, m]));

  if (mapsByPath.size !== maps.length) {
    throw new Error("Duplicate filePath entries in source maps");
  }

  // Phase 2: upload to blob storage with concurrency limit of 5.
  // Validate all tokens have matching entries before starting any uploads.
  for (const token of presigned.files) {
    if (!mapsByPath.has(token.filePath)) {
      throw new Error(
        `Presigned token for "${token.filePath}" has no matching source map entry`,
      );
    }
  }

  // Phase 2: upload to blob storage in chunks of CONCURRENCY
  const CONCURRENCY = 5;
  const uploadResults: Array<{ filePath: string; sizeBytes: number; blobUrl: string }> = [];

  for (let i = 0; i < presigned.files.length; i += CONCURRENCY) {
    const chunk = presigned.files.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (token) => {
        const entry = mapsByPath.get(token.filePath)!;
        const result = await blobUploader(token.clientToken, token.pathname, entry.content);
        return {
          filePath: token.filePath,
          sizeBytes: result.size,
          blobUrl: result.url,
        };
      }),
    );
    uploadResults.push(...chunkResults);
  }

  // Phase 3: submit manifest
  return submitManifest(apiKey, endpoint, presigned.uploadId, buildHash, uploadResults);
}

/**
 * Options for {@link uploadSourceMapsAuto}, primarily used for test injection.
 */
export interface AutoUploadOptions {
  /** Override blob availability check (for testing). */
  checkBlobAvailable?: () => Promise<boolean>;
  /** Override blob uploader (for testing). */
  blobUploader?: BlobUploader;
}

/**
 * Automatically routes source map uploads based on total build size.
 *
 * - Below {@link PRESIGNED_THRESHOLD_BYTES}: uses the legacy single-request
 *   {@link uploadSourceMaps} endpoint.
 * - At or above the threshold: checks if `@vercel/blob` is available and
 *   uses the presigned 3-phase flow. Falls back to legacy with a warning
 *   if the package is not installed.
 */
export async function uploadSourceMapsAuto(
  apiKey: string,
  endpoint: string,
  buildHash: string,
  maps: SourceMapEntry[],
  options?: AutoUploadOptions,
): Promise<SourceMapUploadResponse | SourceMapManifestResponse> {
  if (maps.length === 0) {
    throw new Error("No source maps to upload");
  }

  const totalBytes = maps.reduce(
    (sum, m) => sum + Buffer.byteLength(m.content, "utf-8"),
    0,
  );

  if (totalBytes < PRESIGNED_THRESHOLD_BYTES) {
    return uploadSourceMaps(apiKey, endpoint, buildHash, maps);
  }

  // Check if @vercel/blob is available
  const checkAvailable = options?.checkBlobAvailable ?? (async () => {
    try {
      await import("@vercel/blob/client");
      return true;
    } catch {
      return false;
    }
  });

  const blobAvailable = await checkAvailable();

  if (blobAvailable) {
    return uploadSourceMapsPresigned(
      apiKey, endpoint, buildHash, maps, options?.blobUploader,
    );
  }

  // Fall back to legacy upload with a warning
  sdkLog("warn",
    `[glasstrace] Build exceeds 4.5MB (${totalBytes} bytes). Install @vercel/blob for ` +
    `presigned uploads to avoid serverless body size limits. Falling back to legacy upload.`
  );

  return uploadSourceMaps(apiKey, endpoint, buildHash, maps);
}
