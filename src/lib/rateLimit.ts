import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { supabase } from './supabase';

/**
 * The identity a rate limit is counted against.
 *
 * Not the session id. That is a UUID the browser generates, so counting against
 * it means anyone can reset their own quota by calling crypto.randomUUID() —
 * verified: five uploads under five fresh ids all returned 200. Against a Gemini
 * free tier where two models allow 20 requests a day, that is enough to take the
 * demo down for everyone, repeatedly.
 *
 * The client-visible identity that cannot be rotated at will is the source
 * address, which Vercel forwards. It is hashed before storage: an IP is personal
 * data and there is no reason to keep it in plaintext to count requests. Falls
 * back to the session id when no address is available, which keeps local
 * development working.
 *
 * Trade-off worth knowing: visitors behind one NAT — an office, a university —
 * share a budget. For a portfolio demo that is the right side of the trade.
 */
export function rateLimitIdentity(req: NextRequest, sessionId: string): string {
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  const address = (forwarded.split(',')[0] || req.headers.get('x-real-ip') || '').trim();
  if (!address) return sessionId;

  const digest = createHash('sha256')
    .update(`${process.env.RATE_LIMIT_SALT ?? 'docmind'}:${address}`)
    .digest('hex');

  // Shaped as a UUID so it fits the existing uuid column, with the version and
  // variant nibbles set so it is a well-formed v4-looking value.
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  resetsAt: string | null;
}

/**
 * Fixed-window rate limit, enforced in Postgres.
 *
 * In-memory counters are useless here: every serverless invocation may land on a
 * fresh instance, so the only shared state is the database.
 */
export async function checkRateLimit(
  identity: string,
  bucket: 'chat' | 'ingest',
  windowSecs: number,
  limit: number,
): Promise<RateLimitVerdict> {
  // Fail open. A rate limiter that takes the whole demo down when the RPC hiccups
  // — or when Supabase is not configured yet — is worse than the abuse it prevents.
  try {
    const { data, error } = await supabase().rpc('bump_rate_limit', {
      p_session_id: identity,
      p_bucket: bucket,
      p_window_secs: windowSecs,
      p_limit: limit,
    });

    if (error || !data?.[0]) return { allowed: true, remaining: limit, resetsAt: null };

    const row = data[0] as { allowed: boolean; remaining: number; resets_at: string };
    return { allowed: row.allowed, remaining: row.remaining, resetsAt: row.resets_at };
  } catch {
    return { allowed: true, remaining: limit, resetsAt: null };
  }
}

export const LIMITS = {
  chat: { windowSecs: 600, max: 25 },
  ingest: { windowSecs: 3600, max: 10 },
} as const;
