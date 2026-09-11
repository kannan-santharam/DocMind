import type { NextRequest } from 'next/server';

/**
 * What a visitor sees depends on where they are viewing from.
 *
 * Through the portfolio, DocMind is Kannan's assistant: his profile and the
 * architecture write-up are preloaded, and his phone number and email are
 * available. At its own URL it is a blank document Q&A tool — nothing preloaded,
 * upload something to begin — because there it is a public endpoint that anyone,
 * and anything, can talk to.
 *
 * Two things about the contact half are worth being precise on.
 *
 * First, it is redaction at retrieval, not a rule in the prompt. A system
 * instruction saying "do not share the phone number" still puts the phone number
 * in the model's context, one clever question away from coming back out. Here the
 * passage is rewritten before it reaches the model and before it reaches the
 * citation panel, so there is nothing to extract.
 *
 * Second, it is a disclosure preference, not a security control. The trusted
 * origin arrives from the browser and a determined visitor can forge it — and the
 * same details are published on the portfolio anyway. What this stops is casual
 * scraping of a public chatbot, which is the actual threat.
 */

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Deliberately loose: a digit, then a run of digits and separators, then a digit.
 * Grouping varies too much to enumerate — +91 97902 47499 is 2-5-5, which a
 * 3-3-4 pattern silently misses. `looksLikePhone` below does the real filtering,
 * so "232 specs", "96%", "2011 - 2015" and "30,000 lines" all survive: the
 * character class excludes commas and newlines, and the digit-count check
 * rejects anything short.
 */
const PHONE = /(?:\+\d{1,3}[ .-]?)?\d[\d .()-]{6,18}\d/g;

const REPLACEMENT = '[contact details shared via the portfolio]';

/** Years, spec counts and version strings must survive; phone numbers must not. */
function looksLikePhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return false;
  // A bare run of digits with no separators and no country code is more likely an
  // identifier than a number someone would dial.
  return /[\s.+()-]/.test(candidate) || candidate.startsWith('+') || digits.length >= 11;
}

export function redactContactDetails(text: string): string {
  return text
    .replace(EMAIL, REPLACEMENT)
    .replace(PHONE, (match) => (looksLikePhone(match) ? REPLACEMENT : match));
}

/**
 * Google API keys, as they appear in pasted text.
 *
 * Two formats, because Google issues both:
 *
 *   AIza…  legacy, `AIza` plus 35 characters, 39 in total
 *   AQ.…   current, a short prefix, a dot, then a longer body — the key this
 *          project's own AI Studio project was issued is 53 characters
 *
 * Assuming only the `AIza` shape was a real mistake worth recording: it is the
 * format in every tutorial and every StackOverflow answer, and it silently misses
 * keys minted today. Verified against a live key rather than trusted from memory.
 *
 * Still narrow on purpose. A generic "long random-looking token" rule would mangle
 * documents full of hashes, commit ids and base64, and this exists to catch one
 * specific accident: a visitor pasting a config file or a curl command containing
 * their own key. Without it the key is chunked, embedded, and stored in `chunks`
 * permanently — the one path by which a credential this app is careful never to
 * persist ends up in Postgres anyway, put there by its owner.
 */
const GOOGLE_API_KEY = /\b(?:AIza[0-9A-Za-z_-]{35}|A[A-Za-z0-9]{1,3}\.[A-Za-z0-9_-]{30,120})\b/g;

const KEY_REPLACEMENT = '[API key removed before indexing]';

/**
 * Applied to extracted text at ingest, before it is chunked or embedded, and to
 * everything on its way to Langfuse.
 *
 * Two channels, one function, because a key can arrive through either: pasted
 * into a document, or typed into the chat box by someone who has not spotted the
 * key panel yet. The promise made to visitors — never stored, never traced — has
 * to hold for both, not just for the header it was designed around.
 */
export function redactApiKeys(text: string): string {
  return text.replace(GOOGLE_API_KEY, KEY_REPLACEMENT);
}

/**
 * Deep-scrubs an arbitrary value on its way to a third-party observability sink.
 *
 * Only plain objects are rebuilt. Walking into a Date, Map or class instance with
 * `Object.entries` would return an empty object and quietly destroy it — nothing
 * currently traced is one of those, but a scrubber that silently eats a value it
 * does not understand is a bad thing to leave lying in a hot path.
 */
export function redactApiKeysDeep<T>(value: T): T {
  if (typeof value === 'string') return redactApiKeys(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactApiKeysDeep) as unknown as T;

  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactApiKeysDeep(v)]),
    ) as unknown as T;
  }

  return value;
}

export function containsContactDetails(text: string): boolean {
  return redactContactDetails(text) !== text;
}

/**
 * Origins that get the full experience, as a comma-separated env value:
 *
 *   TRUSTED_ORIGINS=https://kannansantharam.com,https://www.kannansantharam.com,
 *                    https://kannan-ai-dev.vercel.app,http://localhost:5173
 *
 * List both the apex and the www form of a custom domain. The browser reports the
 * origin the visitor actually loaded, and which form is canonical can change.
 *
 * Three things are gated on this, all answering the same question — "is this being
 * viewed through the portfolio?":
 *
 *   1. the preloaded documents (profile, skills, architecture write-up)
 *   2. the phone number and email inside them
 *   3. whether the owner's Gemini key serves the request, or the visitor supplies
 *      their own (see lib/apiKey.ts)
 *
 * The same value also builds `frame-ancestors` in next.config.ts, so an origin
 * missing here cannot frame the app *and* would land in restricted mode if it
 * did. One list, deliberately — two would drift.
 *
 * Unset means nothing is trusted, so the app is a blank document Q&A tool
 * everywhere — the safe default if the variable is ever lost.
 */
function trustedOrigins(): string[] {
  return (process.env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

/**
 * The browser reports the top-level page it is running under — its own origin
 * normally, the parent's when embedded in an iframe. Both integration styles are
 * therefore covered: a link from the portfolio carries `?from=`, an iframe
 * carries the parent origin.
 */
export function isTrustedOrigin(req: NextRequest): boolean {
  const allowed = trustedOrigins();
  if (!allowed.length) return false;

  const claimed = (req.headers.get('x-embed-origin') ?? '')
    .trim()
    .replace(/\/+$/, '')
    .toLowerCase();

  return Boolean(claimed) && allowed.includes(claimed);
}
