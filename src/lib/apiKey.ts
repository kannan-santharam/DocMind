import { createHash } from 'node:crypto';
import type { NextRequest } from 'next/server';

import { env } from './env';
import { isTrustedOrigin } from './privacy';
import { canWriteSharedNamespace } from './session';

/**
 * Whose Gemini quota pays for this request.
 *
 * Through the portfolio, DocMind is Kannan's assistant and runs on his key —
 * a recruiter should not have to obtain a credential to ask about his CV. At the
 * public URL it is a demo anyone can find, and a single free-tier key does not
 * survive that: the daily embedding allowance is ~1000 requests, so a handful of
 * visitors uploading documents exhausts it for everyone, including the portfolio.
 * So direct visitors bring their own key, which is free from AI Studio and takes
 * about a minute to get.
 *
 * The key never leaves the request it arrived on. It is not written to the
 * database, not logged, and not attached to a Langfuse trace — only
 * `keySource` is, so it is possible to tell whose quota served an answer without
 * recording whose credential it was.
 */
export type KeySource = 'owner' | 'visitor';

export interface ResolvedKey {
  key: string;
  source: KeySource;
  /**
   * Stable, non-reversible label for this key, used to partition the in-process
   * quota caches in `gemini.ts`. A visitor hitting their own rate limit must not
   * put a model on cooldown for everybody else sharing the warm instance.
   */
  fingerprint: string;
}

/**
 * Thrown when a request needs a visitor-supplied key and did not carry one.
 * The routes turn this into a 401 with `needsKey: true`, which is the signal the
 * client uses to show the setup panel rather than an error.
 */
export class ApiKeyRequiredError extends Error {}

export const BYOK_HEADER = 'x-gemini-key';

/**
 * Shape check only, and deliberately loose.
 *
 * Google issues at least two key formats: the familiar `AIza` plus 35 characters,
 * and a newer, longer form with a short dotted prefix. Pinning the check to `AIza`
 * would reject keys minted today — worth stating plainly, because that assumption
 * is in every tutorial and it is wrong.
 *
 * What this must do is reject anything that is not safe to put in an HTTP header.
 * undici throws on an interior newline with a message that echoes the whole value,
 * and that message travels into error responses and traces — so a malformed key
 * would leak itself. Hence the character class, not the prefix.
 */
const KEY_SHAPE = /^[A-Za-z0-9_.-]{20,120}$/;

const SETUP_HINT =
  'Get a free Gemini API key at https://aistudio.google.com/apikey, then add it in DocMind to start asking questions. It stays in your browser.';

function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * True when this request is entitled to spend the owner's quota.
 *
 * Two distinct cases, and the second is easy to forget: `scripts/seed.mjs` sends
 * `x-seed-token` but no `x-embed-origin`, so it is *not* a trusted origin. Gating
 * the owner key on trust alone would 401 every seed request and make the shared
 * corpus unrebuildable — the same shape of bug as the IP rate limiter locking out
 * seeding, so authorised shared-namespace writes are exempted here too.
 */
function useOwnerKey(req: NextRequest): boolean {
  return isTrustedOrigin(req) || canWriteSharedNamespace(req);
}

export function resolveApiKey(req: NextRequest): ResolvedKey {
  if (useOwnerKey(req)) {
    const key = env.geminiApiKey;
    return { key, source: 'owner', fingerprint: fingerprint(key) };
  }

  const supplied = (req.headers.get(BYOK_HEADER) ?? '').trim();
  if (!supplied) {
    throw new ApiKeyRequiredError(`This demo runs on your own Gemini key. ${SETUP_HINT}`);
  }
  if (!KEY_SHAPE.test(supplied)) {
    throw new ApiKeyRequiredError(
      `That does not look like a Gemini API key — it has characters a key never contains. Copy it again straight from AI Studio. ${SETUP_HINT}`,
    );
  }

  return { key: supplied, source: 'visitor', fingerprint: fingerprint(supplied) };
}
