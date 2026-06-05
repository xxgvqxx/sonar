import crypto from 'node:crypto';
import { db } from './db.ts';

// Per-member access tokens with individual revocation. The token secret is shown ONCE at creation;
// the DB only ever holds its sha-256 hash, so the database is not a credential store. A teammate
// authenticates with the secret (Authorization: Bearer …); we hash the supplied value and look up a
// non-revoked row. Tokens are high-entropy (144 bits), so a constant-time-per-row scan isn't needed —
// a single indexed hash lookup is not a useful timing oracle.

const now = () => new Date().toISOString();
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export function createToken(name: string): { name: string; token: string } {
  const clean = name.trim();
  if (!clean) throw new Error('a token name is required (e.g. a teammate handle)');
  const existing = db.prepare('SELECT revoked_at FROM auth_tokens WHERE name = ?').get(clean) as any;
  if (existing && !existing.revoked_at) throw new Error(`a token named "${clean}" is already active — revoke it first or pick another name`);
  const token = crypto.randomBytes(18).toString('base64url');
  // If the name was used before and revoked, free it so the UNIQUE(name) holds.
  if (existing) db.prepare('DELETE FROM auth_tokens WHERE name = ?').run(clean);
  db.prepare('INSERT INTO auth_tokens (name, token_hash, created_at) VALUES (?, ?, ?)').run(clean, hash(token), now());
  return { name: clean, token };
}

export function listTokens() {
  return db.prepare('SELECT name, created_at, last_used_at, revoked_at FROM auth_tokens ORDER BY created_at DESC').all() as any[];
}

/** Revoke by member name, or by the raw token value. Returns how many rows were revoked. */
export function revokeToken(nameOrToken: string): { revoked: number; name?: string } {
  const ts = now();
  let row = db.prepare('SELECT id, name FROM auth_tokens WHERE name = ? AND revoked_at IS NULL').get(nameOrToken) as any;
  if (!row) row = db.prepare('SELECT id, name FROM auth_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hash(nameOrToken)) as any;
  if (!row) return { revoked: 0 };
  db.prepare('UPDATE auth_tokens SET revoked_at = ? WHERE id = ?').run(ts, row.id);
  return { revoked: 1, name: row.name };
}

/** Verify a presented token. Returns the member name if it's active (and stamps last_used), else null. */
export function verifyToken(token: string): string | null {
  if (!token) return null;
  const row = db.prepare('SELECT id, name FROM auth_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hash(token)) as any;
  if (!row) return null;
  db.prepare('UPDATE auth_tokens SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return row.name as string;
}

export function anyActive(): boolean {
  return !!(db.prepare('SELECT 1 FROM auth_tokens WHERE revoked_at IS NULL LIMIT 1').get());
}
