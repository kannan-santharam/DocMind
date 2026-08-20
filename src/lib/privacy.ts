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

export function containsContactDetails(text: string): boolean {
  return redactContactDetails(text) !== text;
}

/**
 * Origins that get the full experience, as a comma-separated env value:
 *
 *   TRUSTED_ORIGINS=https://kannan-ai-dev.vercel.app,http://localhost:5173
 *
 * Two things are gated on this, both answering the same question — "is this being
 * viewed through the portfolio?":
 *
 *   1. the preloaded documents (profile, skills, architecture write-up)
 *   2. the phone number and email inside them
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
