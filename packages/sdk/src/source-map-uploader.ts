import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import {
  SourceMapUploadResponseSchema,
  type SourceMapUploadResponse,
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

  const baseUrl = endpoint.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/v1/source-maps`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `Source map upload failed: ${String(response.status)} ${response.statusText}`,
    );
  }

  const json: unknown = await response.json();
  return SourceMapUploadResponseSchema.parse(json);
}
