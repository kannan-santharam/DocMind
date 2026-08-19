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
    return required('GEMINI_API_KEY');
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
