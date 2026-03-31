import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { AnonApiKeySchema, createAnonApiKey } from "@glasstrace/protocol";
import type { AnonApiKey } from "@glasstrace/protocol";

const GLASSTRACE_DIR = ".glasstrace";
const ANON_KEY_FILE = "anon_key";

/**
 * In-memory cache for ephemeral keys when filesystem persistence fails.
 * Keyed by resolved project root to support multiple roots in tests.
 */
const ephemeralKeyCache = new Map<string, AnonApiKey>();

/**
 * Reads an existing anonymous key from the filesystem.
 * Returns the key if valid, or null if:
 * - The file does not exist
 * - The file content is invalid
 * - An I/O error occurs
 */
export async function readAnonKey(projectRoot?: string): Promise<AnonApiKey | null> {
  const root = projectRoot ?? process.cwd();
  const keyPath = join(root, GLASSTRACE_DIR, ANON_KEY_FILE);

  try {
    const content = await readFile(keyPath, "utf-8");
    const result = AnonApiKeySchema.safeParse(content);
    if (result.success) {
      return result.data;
    }
  } catch {
    // Fall through to check ephemeral cache
  }

  // Check in-memory cache (used when filesystem persistence failed)
  const cached = ephemeralKeyCache.get(root);
  if (cached !== undefined) {
    return cached;
  }

  return null;
}

/**
 * Gets an existing anonymous key from the filesystem, or creates a new one.
 *
 * - If file exists and contains a valid key, returns it
 * - If file does not exist or content is invalid, generates a new key via createAnonApiKey()
 * - Writes the new key to `.glasstrace/anon_key`, creating the directory if needed
 * - On file write failure: logs a warning, caches an ephemeral in-memory key so
 *   repeated calls in the same process return the same key
 */
export async function getOrCreateAnonKey(projectRoot?: string): Promise<AnonApiKey> {
  const root = projectRoot ?? process.cwd();
  const dirPath = join(root, GLASSTRACE_DIR);
  const keyPath = join(dirPath, ANON_KEY_FILE);

  // Try reading existing key from filesystem
  const existingKey = await readAnonKey(root);
  if (existingKey !== null) {
    return existingKey;
  }

  // Check in-memory cache (used when filesystem is unavailable)
  const cached = ephemeralKeyCache.get(root);
  if (cached !== undefined) {
    return cached;
  }

  // Generate a new key
  const newKey = createAnonApiKey();

  // Persist to filesystem
  try {
    await mkdir(dirPath, { recursive: true, mode: 0o700 });
    await writeFile(keyPath, newKey, "utf-8");
    await chmod(keyPath, 0o600);
  } catch (err) {
    // Cache in memory so repeated calls get the same ephemeral key
    ephemeralKeyCache.set(root, newKey);
    console.warn(
      `[glasstrace] Failed to persist anonymous key to ${keyPath}: ${err instanceof Error ? err.message : String(err)}. Using ephemeral key.`,
    );
  }

  return newKey;
}
