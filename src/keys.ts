/** API key lifecycle. Secrets exist in plaintext exactly once (at mint). */
import crypto from 'node:crypto';

export interface MintedKey {
  /** Full secret — shown ONCE, never stored, never logged. */
  secret: string;
  hash: string;
  prefix: string;
}

export function mintKey(): MintedKey {
  const secret = 'orin_' + crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  return { secret, hash, prefix: secret.slice(0, 12) };
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/** Constant-time comparison — no oracle on prefix guessing. */
export function verifySecret(secret: string, hash: string): boolean {
  const a = Buffer.from(hashSecret(secret));
  const b = Buffer.from(hash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function bearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1] : null;
}
