import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
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
    const sha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
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

  // Strip trailing slashes iteratively to avoid regex (CodeQL js/polynomial-redos).
  let baseUrl = endpoint;
  while (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }
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
// Presigned upload flow (3-phase)
// ---------------------------------------------------------------------------

/** Builds at or above this byte size route to the presigned upload flow. */
export const PRESIGNED_THRESHOLD_BYTES = 4_500_000; // 4.5 MB — Vercel serverless body limit

/**
 * Strips trailing slashes from a URL string.
 * Extracted to avoid duplicating the while-loop pattern.
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
 * file metadata. The response contains per-file client tokens for direct
 * upload to Vercel Blob storage.
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
 * Phase 2: Upload a single source map file to Vercel Blob storage.
 *
 * Uses the `@vercel/blob` client SDK via dynamic import so the dependency
 * is optional — only required when builds exceed the presigned threshold.
 */
export async function uploadToBlob(
  clientToken: string,
  pathname: string,
  content: string,
): Promise<{ url: string; size: number }> {
  let mod: typeof import("@vercel/blob/client");
  try {
    mod = await import("@vercel/blob/client");
  } catch {
    throw new Error(
      "Presigned upload requires @vercel/blob. Install it: npm install @vercel/blob",
    );
  }

  const result = await mod.put(pathname, new Blob([content]), {
    access: "public",
    token: clientToken,
  });

  return { url: result.url, size: Buffer.byteLength(content, "utf-8") };
}

/**
 * Phase 3: Submit the upload manifest to activate source maps.
 *
 * POSTs to `{endpoint}/v1/source-maps/manifest` with the upload ID,
 * build hash, and blob URLs for each uploaded file.
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

/** Function signature for uploading a single file to blob storage. */
export type BlobUploader = (
  clientToken: string,
  pathname: string,
  content: string,
) => Promise<{ url: string; size: number }>;

/**
 * Orchestrates the full presigned upload flow (3 phases).
 *
 * 1. Requests presigned tokens for each file.
 * 2. Uploads files to Vercel Blob with bounded concurrency.
 * 3. Submits the manifest to activate the source maps.
 *
 * If any blob upload fails, Phase 3 is skipped — the backend's TTL cleanup
 * will garbage-collect any staged blobs.
 *
 * @param blobUploader - Optional custom blob upload function (defaults to
 *   `uploadToBlob`). Exposed for testing; production callers should omit.
 */
export async function uploadSourceMapsPresigned(
  apiKey: string,
  endpoint: string,
  buildHash: string,
  maps: SourceMapEntry[],
  blobUploader: BlobUploader = uploadToBlob,
): Promise<SourceMapManifestResponse> {
  // Phase 1: get presigned tokens
  const presignedResponse = await requestPresignedTokens(
    apiKey,
    endpoint,
    buildHash,
    maps.map((m) => ({ filePath: m.filePath, sizeBytes: Buffer.byteLength(m.content, "utf-8") })),
  );

  // Phase 2: upload to blob storage with bounded concurrency
  const CONCURRENCY = 5;
  const results: Array<{ filePath: string; sizeBytes: number; blobUrl: string }> = [];
  const executing = new Set<Promise<void>>();
  const mapsByPath = new Map(maps.map((m) => [m.filePath, m]));

  try {
    for (const file of presignedResponse.files) {
      const mapEntry = mapsByPath.get(file.filePath);
      if (!mapEntry) {
        throw new Error(`Presigned token for "${file.filePath}" has no matching source map entry`);
      }

      // Wrap the upload in a tracked promise that removes itself from the
      // executing set on completion. Using a single promise chain avoids
      // orphaned rejection handlers that cause unhandled-rejection warnings.
      const task: Promise<void> = (async () => {
        const { url } = await blobUploader(file.clientToken, file.pathname, mapEntry.content);
        results.push({ filePath: file.filePath, sizeBytes: Buffer.byteLength(mapEntry.content, "utf-8"), blobUrl: url });
      })().finally(() => {
        executing.delete(task);
      });

      executing.add(task);

      if (executing.size >= CONCURRENCY) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);
  } catch (err) {
    // Wait for all in-flight tasks to settle before re-throwing
    await Promise.allSettled(executing);
    throw err;
  }

  // Phase 3: submit manifest
  return submitManifest(
    apiKey,
    endpoint,
    presignedResponse.uploadId,
    buildHash,
    results,
  );
}

/**
 * Checks whether `@vercel/blob` is available as a runtime dependency.
 * Extracted for testability — dynamic imports are difficult to mock.
 */
export async function isBlobClientAvailable(): Promise<boolean> {
  try {
    await import("@vercel/blob/client");
    return true;
  } catch {
    return false;
  }
}

/** Options for customizing auto-routing upload behavior (exposed for testing). */
export interface UploadSourceMapsAutoOptions {
  /** Override the blob availability check. Defaults to `isBlobClientAvailable`. */
  checkBlobAvailable?: () => Promise<boolean>;
  /** Override the blob upload function. Defaults to `uploadToBlob`. */
  blobUploader?: BlobUploader;
}

/**
 * Auto-routing upload: uses the legacy single-POST for small builds
 * (<4.5 MB) and the presigned 3-phase flow for large builds.
 *
 * If `@vercel/blob` is not installed and the build exceeds the threshold,
 * falls back to the legacy upload with a warning — the request may fail
 * if the backend enforces a body-size limit.
 */
export async function uploadSourceMapsAuto(
  apiKey: string,
  endpoint: string,
  buildHash: string,
  maps: SourceMapEntry[],
  options?: UploadSourceMapsAutoOptions,
): Promise<SourceMapUploadResponse | SourceMapManifestResponse> {
  const totalSize = maps.reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf-8"), 0);

  if (totalSize < PRESIGNED_THRESHOLD_BYTES) {
    return uploadSourceMaps(apiKey, endpoint, buildHash, maps);
  }

  // Large build — attempt presigned flow
  const checkAvailable = options?.checkBlobAvailable ?? isBlobClientAvailable;
  if (!(await checkAvailable())) {
    console.warn(
      "[@glasstrace/sdk] Build exceeds 4.5 MB but @vercel/blob is not installed. " +
      "Falling back to legacy upload which may fail for large builds. " +
      "Install it: npm install @vercel/blob",
    );
    return uploadSourceMaps(apiKey, endpoint, buildHash, maps);
  }

  return uploadSourceMapsPresigned(
    apiKey, endpoint, buildHash, maps,
    options?.blobUploader,
  );
}
