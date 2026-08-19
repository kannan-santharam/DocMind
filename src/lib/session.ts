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

/** Namespaces a visitor may read from: their own, plus the public one. */
export function readableSessions(sessionId: string): string[] {
  return sessionId === SEED_SESSION_ID ? [sessionId] : [sessionId, SEED_SESSION_ID];
}

export class SessionError extends Error {}

export function requireSessionId(req: NextRequest): string {
  const id = readSessionId(req);
  if (!id) throw new SessionError('Missing or malformed x-session-id header.');
  return id;
}
