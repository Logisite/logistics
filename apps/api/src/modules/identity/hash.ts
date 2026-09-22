import { createHash } from 'node:crypto';

/**
 * SHA-256 hex digest for joinable-but-opaque log correlation IDs.
 * Use for phones, nonces, and anything that must never be logged raw.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
