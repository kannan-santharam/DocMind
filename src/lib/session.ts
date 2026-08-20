import type { NextRequest } from 'next/server';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Every row in the database is namespaced by session id.
 *
 * The demo is public and has no accounts, so the client generates a v4 UUID once
 * and keeps it in localStorage. It is unguessable in practice, which is the only
 * property this needs: it stops visitor A's upload from answering visitor B's
 * question. It is explicitly not an authorisation boundary — see README.
 */
export function readSessionId(req: NextRequest): string | null {
  const id = req.headers.get('x-session-id');
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

/**
 * The namespace holding documents every visitor can see — currently the
 * architecture write-up for this project, so a recruiter arriving with an empty
 * session still has something to ask about.
 *
 * Public documents are identified by session id rather than by a column, which
 * keeps the whole feature in application code: no schema migration, and
 * `match_chunks` keeps its exact signature (`create or replace function` cannot
 * change an argument list without creating a second, ambiguous overload).
 *
 * Cost of that choice: retrieval runs the search twice, once per namespace, and
 * merges. One extra Postgres round trip per search, which is cheap next to the
 * embedding call that precedes it.
 */
export const SEED_SESSION_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Namespaces a visitor may read from.
 *
 * Their own always. The preloaded namespace only when viewing through a trusted
 * origin — reached directly, the app starts empty and asks for an upload.
 *
 * Order matters: the caller's own namespace is always first, because retrieval
 * reserves result slots for it by position.
 */
export function readableSessions(sessionId: string, includePreloaded: boolean): string[] {
  if (sessionId === SEED_SESSION_ID) return [sessionId];
  return includePreloaded ? [sessionId, SEED_SESSION_ID] : [sessionId];
}

/**
 * Writes to the shared namespace require a secret.
 *
 * SEED_SESSION_ID is a constant in a public repository, so without this anyone
 * could POST a document under it and have it appear, permanently and to every
 * visitor, as part of Kannan's indexed profile — cited by the agent as fact. The
 * read path is deliberately open; only writing is gated.
 *
 * No token configured means seeding is disabled rather than open. Fail closed.
 */
export function canWriteSharedNamespace(req: NextRequest): boolean {
  const expected = process.env.SEED_TOKEN;
  if (!expected) return false;

  const provided = req.headers.get('x-seed-token') ?? '';
  // Same-length comparison, so the check does not leak the token's length.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class SessionError extends Error {}

export function requireSessionId(req: NextRequest): string {
  const id = readSessionId(req);
  if (!id) throw new SessionError('Missing or malformed x-session-id header.');
  return id;
}
