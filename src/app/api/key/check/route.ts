import { NextResponse, type NextRequest } from 'next/server';

import { ApiKeyRequiredError, resolveApiKey } from '@/lib/apiKey';
import { checkRateLimit, LIMITS, rateLimitIdentity } from '@/lib/rateLimit';
import { readSessionId } from '@/lib/session';

export const runtime = 'nodejs';

/** Stand-in identity for a key check that arrives before a session exists. */
const NO_SESSION = '00000000-0000-4000-8000-0000000000ff';

/**
 * Does this key work?
 *
 * Exists so a visitor pasting a key gets told immediately, instead of finding out
 * through a failed question that reads like the app is broken. `GET /v1beta/models`
 * is the cheapest possible proof: it authenticates the key and consumes no tokens
 * and no embedding quota, so a typo costs the visitor nothing.
 *
 * Two things this route is careful about, both because the credential is not ours:
 *
 *   - the key travels in `x-goog-api-key`, never in the URL, so it cannot be
 *     captured by access logs on the way out;
 *   - Google's error body is never forwarded. It can echo request details, and a
 *     rejected key is one bad paste away from a valid one — there is nothing in
 *     that body a visitor needs and something in it they might not want relayed.
 */
export async function POST(req: NextRequest) {
  // Rate-limited on the same identity as everything else. Without it this is a
  // free, unauthenticated endpoint for checking whether a key is live.
  const limit = await checkRateLimit(
    // The fallback has to be UUID-shaped: with no forwarded address
    // `rateLimitIdentity` returns the session id verbatim, and it lands in a uuid
    // column. A literal like 'anonymous' would make the limiter fail open on a
    // cast error instead of counting.
    rateLimitIdentity(req, readSessionId(req) ?? NO_SESSION),
    'keyCheck',
    LIMITS.keyCheck.windowSecs,
    LIMITS.keyCheck.max,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { error: `Too many key checks. Try again after ${limit.resetsAt}.` },
      { status: 429 },
    );
  }

  let key: string;
  try {
    // Reuses the shape validation, and returns `valid` without a network call
    // when the caller is entitled to the owner's key — a trusted origin has no
    // key to check.
    const resolved = resolveApiKey(req);
    if (resolved.source === 'owner') return NextResponse.json({ valid: true, source: 'owner' });
    key = resolved.key;
  } catch (error) {
    if (error instanceof ApiKeyRequiredError) {
      return NextResponse.json({ valid: false, error: error.message }, { status: 400 });
    }
    throw error;
  }

  let response: Response;
  try {
    response = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return NextResponse.json(
      { valid: false, error: 'Could not reach Google to check the key. Try again in a moment.' },
      { status: 502 },
    );
  }

  if (response.ok) return NextResponse.json({ valid: true, source: 'visitor' });

  const message =
    response.status === 400 || response.status === 401 || response.status === 403
      ? 'Google rejected that key. Check you copied all of it, and that the Generative Language API is enabled for the project it belongs to.'
      : response.status === 429
        ? 'That key is valid but currently rate-limited by Google. It should work again shortly.'
        : `Google returned an unexpected status (${response.status}) while checking the key.`;

  // 200 with valid:false — the check itself succeeded, the key is the problem.
  // A non-2xx here would make the client show a transport error instead.
  return NextResponse.json({ valid: response.status === 429, error: message });
}
