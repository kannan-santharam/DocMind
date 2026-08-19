import { supabase } from './supabase';

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
  sessionId: string,
  bucket: 'chat' | 'ingest',
  windowSecs: number,
  limit: number,
): Promise<RateLimitVerdict> {
  // Fail open. A rate limiter that takes the whole demo down when the RPC hiccups
  // — or when Supabase is not configured yet — is worse than the abuse it prevents.
  try {
    const { data, error } = await supabase().rpc('bump_rate_limit', {
      p_session_id: sessionId,
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
