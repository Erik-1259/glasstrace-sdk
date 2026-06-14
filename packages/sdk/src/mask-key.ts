/**
 * Mask an API key for safe inclusion in logs and lifecycle events —
 * shows a short prefix and the last 4 characters, never the full secret.
 *
 * Keys longer than 12 characters render as `prefix(8) + "..." + last4`;
 * shorter keys collapse to `prefix(4) + "..."` so the tail of a short key
 * is never disclosed. This is the single masking implementation shared by
 * every SDK surface that needs to reference a key (the register flow and
 * the decision-trace emitter), so the masking contract stays consistent.
 *
 * @internal
 */
export function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + "...";
  return key.slice(0, 8) + "..." + key.slice(-4);
}
