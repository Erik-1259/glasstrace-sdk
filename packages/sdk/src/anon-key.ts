import { AnonApiKeySchema, createAnonApiKey } from "@glasstrace/protocol";
import type { AnonApiKey } from "@glasstrace/protocol";

const GLASSTRACE_DIR = ".glasstrace";
const ANON_KEY_FILE = "anon_key";

/**
 * Lazily imports `node:fs/promises` and `node:path`. Returns `null` if
 * the modules are unavailable (non-Node environments). The result is
 * cached after first resolution.
 */
let fsPathCache: { fs: typeof import("node:fs/promises"); path: typeof import("node:path") } | null | undefined;

async function loadFsPath(): Promise<{ fs: typeof import("node:fs/promises"); path: typeof import("node:path") } | null> {
  if (fsPathCache !== undefined) return fsPathCache;
  try {
    const [fs, path] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
    ]);
    fsPathCache = { fs, path };
    return fsPathCache;
  } catch {
    fsPathCache = null;
    return null;
  }
}

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
 * - `node:fs` is unavailable (non-Node environment)
 */
export async function readAnonKey(projectRoot?: string): Promise<AnonApiKey | null> {
  const root = projectRoot ?? process.cwd();

  const modules = await loadFsPath();
  if (modules) {
    const keyPath = modules.path.join(root, GLASSTRACE_DIR, ANON_KEY_FILE);
    try {
      const content = await modules.fs.readFile(keyPath, "utf-8");
      const result = AnonApiKeySchema.safeParse(content);
      if (result.success) {
        return result.data;
      }
    } catch {
      // Fall through to check ephemeral cache
    }
  }

  // Check in-memory cache (used when filesystem persistence failed
  // or when node:fs is unavailable)
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
 * - In non-Node environments: returns an ephemeral in-memory key
 */
export async function getOrCreateAnonKey(projectRoot?: string): Promise<AnonApiKey> {
  const root = projectRoot ?? process.cwd();

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

  // Attempt filesystem persistence (only in Node.js environments)
  const modules = await loadFsPath();
  if (!modules) {
    // No filesystem access — cache in memory
    ephemeralKeyCache.set(root, newKey);
    return newKey;
  }

  const dirPath = modules.path.join(root, GLASSTRACE_DIR);
  const keyPath = modules.path.join(dirPath, ANON_KEY_FILE);

  // Persist to filesystem using atomic create-or-fail (O_CREAT | O_EXCL)
  // to prevent TOCTOU races where concurrent cold starts both generate keys.
  try {
    await modules.fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
    await modules.fs.writeFile(keyPath, newKey, { flag: "wx", mode: 0o600 });
    return newKey;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Another process won the race. Retry reading their key with
      // short delays — the winner's writeFile is atomic for small
      // payloads but the filesystem may not have flushed yet.
      for (let attempt = 0; attempt < 3; attempt++) {
        const winnerKey = await readAnonKey(root);
        if (winnerKey !== null) {
          return winnerKey;
        }
        // Short delay before next retry (50ms), skip after final attempt
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      // All retries exhausted — overwrite as last resort.
      // Use explicit chmod after overwrite since writeFile mode only
      // applies on creation on some platforms.
      try {
        await modules.fs.writeFile(keyPath, newKey, { mode: 0o600 });
        await modules.fs.chmod(keyPath, 0o600);
        return newKey;
      } catch {
        // Overwrite failed — fall through to ephemeral cache
      }
    }

    // Non-EEXIST error (EACCES, ENOTDIR, etc.) — cache in memory so
    // repeated calls get the same ephemeral key within this process.
    ephemeralKeyCache.set(root, newKey);
    console.warn(
      `[glasstrace] Failed to persist anonymous key to ${keyPath}: ${err instanceof Error ? err.message : String(err)}. Using ephemeral key.`,
    );
    return newKey;
  }
}
