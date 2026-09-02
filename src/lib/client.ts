'use client';

import type { ChatSettings } from './settings';
import type { ChatStreamEvent, DocumentRecord } from './types';
import { DEFAULT_REGION, type Region } from './region';

const SESSION_KEY = 'docmind-session-id';
const API_KEY_KEY = 'docmind-gemini-key';

/**
 * The session id namespaces every row this visitor creates. Generated client-side
 * and kept in localStorage so a reload keeps the uploaded documents; cleared by
 * "New session".
 */
export function getSessionId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

export function resetSessionId(): string {
  const id = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, id);
  return id;
}

/**
 * The page this app is actually being viewed under: the parent's origin when
 * embedded in an iframe, its own otherwise. The server matches it against an
 * allowlist to decide whether contact details may be shared.
 */
function embedOrigin(): string {
  if (typeof window === 'undefined') return '';
  try {
    const ancestors = window.location.ancestorOrigins;
    if (ancestors?.length) return ancestors[0];
    if (window.parent !== window && document.referrer) {
      return new URL(document.referrer).origin;
    }
  } catch {
    /* cross-origin access denied — fall through to our own origin */
  }
  return window.location.origin;
}

/**
 * The visitor's own Gemini key, when they have supplied one.
 *
 * localStorage rather than a cookie: a cookie is attached to every request the
 * browser makes to this origin, including ones that have no business carrying a
 * credential, and it would survive into places this app does not control. Here
 * the key is read explicitly, attached to the three routes that need it, and
 * removable by the visitor at any time.
 *
 * It is deliberately not tied to the session id. Clearing the session throws away
 * uploaded documents; there is no reason that should also throw away the key and
 * make them fetch it from AI Studio again.
 */
export function getStoredApiKey(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(API_KEY_KEY) ?? '';
}

export function storeApiKey(key: string): void {
  localStorage.setItem(API_KEY_KEY, key.trim());
}

export function clearStoredApiKey(): void {
  localStorage.removeItem(API_KEY_KEY);
}

/**
 * Raised when a request needs the visitor's own key and did not have a working
 * one. Distinct from a generic failure so the UI can open the setup panel rather
 * than render a sentence about a 401.
 */
export class ApiKeyNeededError extends Error {}

/**
 * A `?region=in` in this page's own URL, forwarded so the server can honour it.
 *
 * The server normally decides region from `x-vercel-ip-country`, which does not
 * exist on a dev server and cannot be changed to test a deploy — without this
 * the India path would be unreachable and therefore unverifiable. It also lets
 * the portfolio forward its own `/ind` choice by framing `…/?region=in`.
 *
 * Forgeable, and that is fine: both editions of the profile are already public
 * on the portfolio, so there is nothing here to protect. See `lib/region.ts`.
 */
function regionOverride(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('region') ?? '';
}

function sessionHeaders(sessionId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'x-session-id': sessionId,
    'x-embed-origin': embedOrigin(),
  };
  const region = regionOverride();
  if (region) headers['x-region-override'] = region;
  return headers;
}

/**
 * Session headers plus the visitor's key, for the two routes that actually spend
 * Gemini quota.
 *
 * Kept separate from `sessionHeaders` on purpose. Attaching the key at the single
 * chokepoint would have been less code and would have sent someone else's
 * credential along with every document listing and every delete — requests that
 * have no use for it. A credential should travel exactly as far as it is needed
 * and no further, and the panel tells visitors it is "sent with each question",
 * which should be true rather than approximately true.
 */
function keyedHeaders(sessionId: string): Record<string, string> {
  const headers = { ...sessionHeaders(sessionId) };
  const apiKey = getStoredApiKey();
  if (apiKey) headers['x-gemini-key'] = apiKey;
  return headers;
}

async function unwrap<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw toError(payload, response.status, 'Request failed');
  }
  return payload as T;
}

function toError(payload: unknown, status: number, fallback: string): Error {
  const { error, needsKey } = (payload ?? {}) as { error?: string; needsKey?: boolean };
  const message = error ?? `${fallback} (${status}).`;
  return needsKey ? new ApiKeyNeededError(message) : new Error(message);
}

export interface KeyCheck {
  valid: boolean;
  error?: string;
}

/**
 * Asks the server to confirm a key works before it is stored, so a bad paste is
 * caught at the point it was made rather than by the next question failing.
 */
export async function checkApiKey(sessionId: string, key: string): Promise<KeyCheck> {
  const response = await fetch('/api/key/check', {
    method: 'POST',
    headers: { 'x-session-id': sessionId, 'x-gemini-key': key.trim() },
  });
  const payload = (await response.json().catch(() => ({}))) as KeyCheck;
  if (!response.ok && payload.valid === undefined) {
    return { valid: false, error: payload.error ?? `Could not check the key (${response.status}).` };
  }
  return payload;
}

export interface DocumentList {
  documents: DocumentRecord[];
  /** True when this origin is trusted, so the preloaded documents are in scope. */
  trusted: boolean;
  /**
   * Which edition of the profile this visitor is being shown. Carried on the
   * same response as `trusted` rather than through a second endpoint, because
   * the landing copy needs both before it renders and they are answers to the
   * same question: what should this particular visitor be told?
   */
  region: Region;
}

export async function fetchDocuments(sessionId: string): Promise<DocumentList> {
  const response = await fetch('/api/documents', { headers: sessionHeaders(sessionId) });
  const { documents, trusted, region } = await unwrap<DocumentList>(response);
  return { documents, trusted: Boolean(trusted), region: region ?? DEFAULT_REGION };
}

export async function deleteDocument(sessionId: string, id?: string): Promise<void> {
  const response = await fetch(`/api/documents${id ? `?id=${id}` : ''}`, {
    method: 'DELETE',
    headers: sessionHeaders(sessionId),
  });
  await unwrap(response);
}

export interface IngestResult {
  document: DocumentRecord;
  notes: string[];
}

export async function uploadFile(sessionId: string, file: File): Promise<IngestResult> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/ingest', {
    method: 'POST',
    headers: keyedHeaders(sessionId),
    body: form,
  });
  const { document, notes } = await unwrap<IngestResult>(response);
  return { document, notes: notes ?? [] };
}

export async function ingestText(
  sessionId: string,
  text: string,
  title: string,
): Promise<IngestResult> {
  const response = await fetch('/api/ingest', {
    method: 'POST',
    headers: { ...keyedHeaders(sessionId), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, title }),
  });
  const { document, notes } = await unwrap<IngestResult>(response);
  return { document, notes: notes ?? [] };
}

/**
 * Opens the chat stream and yields decoded SSE events.
 *
 * `fetch` + ReadableStream rather than EventSource: the request is a POST with a
 * JSON body and a session header, none of which EventSource supports.
 */
export async function* streamChat(
  sessionId: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  settings: ChatSettings,
  signal: AbortSignal,
): AsyncGenerator<ChatStreamEvent> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { ...keyedHeaders(sessionId), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, settings }),
    signal,
  });

  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw toError(payload, response.status, 'Chat failed');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function decodeLine(line: string): ChatStreamEvent | null {
    if (!line.startsWith('data:')) return null;
    const payload = line.slice(5).trim();
    if (!payload) return null;
    try {
      return JSON.parse(payload) as ChatStreamEvent;
    } catch {
      return null; // partial frame; the next read completes it
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const event = decodeLine(line);
      if (event) yield event;
    }
  }

  // A final frame with no trailing newline would otherwise be dropped, losing the
  // tail of the answer or the citations event.
  buffer += decoder.decode();
  const tail = decodeLine(buffer.trim());
  if (tail) yield tail;
}
