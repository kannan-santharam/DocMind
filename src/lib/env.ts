/**
 * Server-only environment access.
 *
 * Nothing here is NEXT_PUBLIC_-prefixed on purpose: the Gemini key and the
 * Supabase service-role key must never reach the browser bundle.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example for setup.`,
    );
  }
  return value;
}

export const env = {
  get geminiApiKey() {
    /**
     * Trimmed, and rejected outright if it is not header-safe.
     *
     * Not defensive padding. `authHeaders` puts this value in an outbound header,
     * and undici throws `TypeError: Headers.append: "<the whole value>" is an
     * invalid header value` on an interior newline — a message that then travels
     * into a 500 response body and into a Langfuse trace, carrying the key with
     * it. A multi-line paste into the Vercel dashboard is all it takes. Visitor
     * keys are already screened by KEY_SHAPE in lib/apiKey.ts; this closes the
     * same hole on the owner's side.
     */
    const value = required('GEMINI_API_KEY').trim();
    if (/[\s:]/.test(value)) {
      throw new Error(
        'GEMINI_API_KEY contains whitespace or a colon, so it cannot be sent as a request header. Re-paste it as a single line.',
      );
    }
    return value;
  },
  get supabaseUrl() {
    // The dashboard shows the REST endpoint next to the project URL, so
    // `.../rest/v1/` is an easy thing to paste. supabase-js wants the bare origin.
    return required('SUPABASE_URL').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  },
  get supabaseServiceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY');
  },
};

/** True when every service the app depends on is configured. */
export function isConfigured(): boolean {
  return Boolean(
    process.env.GEMINI_API_KEY &&
      process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}
