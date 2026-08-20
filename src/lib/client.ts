'use client';

import type { ChatSettings } from './settings';
import type { ChatStreamEvent, DocumentRecord } from './types';

const SESSION_KEY = 'docmind-session-id';

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

function sessionHeaders(sessionId: string): HeadersInit {
  return { 'x-session-id': sessionId, 'x-embed-origin': embedOrigin() };
}

async function unwrap<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error ?? `Request failed (${response.status}).`);
  }
  return payload as T;
}

export interface DocumentList {
  documents: DocumentRecord[];
  /** True when this origin is trusted, so the preloaded documents are in scope. */
  trusted: boolean;
}

export async function fetchDocuments(sessionId: string): Promise<DocumentList> {
  const response = await fetch('/api/documents', { headers: sessionHeaders(sessionId) });
  const { documents, trusted } = await unwrap<DocumentList>(response);
  return { documents, trusted: Boolean(trusted) };
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
    headers: sessionHeaders(sessionId),
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
    headers: { ...sessionHeaders(sessionId), 'Content-Type': 'application/json' },
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
    headers: { ...sessionHeaders(sessionId), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, settings }),
    signal,
  });

  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    throw new Error((payload as { error?: string }).error ?? `Chat failed (${response.status}).`);
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
