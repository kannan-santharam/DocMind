'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  deleteDocument,
  fetchDocuments,
  ingestText,
  uploadFile,
} from '@/lib/client';
import type { DocumentRecord } from '@/lib/types';

export interface UploadState {
  filename: string;
  stage: 'parsing' | 'embedding';
}

export function useDocuments(sessionId: string) {
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [uploading, setUploading] = useState<UploadState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Non-fatal parser warnings from the last upload: what could not be read. */
  const [notices, setNotices] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      setDocuments(await fetchDocuments(sessionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load documents.');
    } finally {
      setLoaded(true);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const ingest = useCallback(
    async (input: File | { text: string; title: string }) => {
      if (!sessionId) return;
      const filename = input instanceof File ? input.name : input.title || 'Pasted text';
      setError(null);
      setNotices([]);
      setUploading({ filename, stage: 'parsing' });

      // The server does parse -> embed in one request; this is a coarse UI hint,
      // not a real progress signal.
      const toEmbedding = setTimeout(
        () => setUploading((s) => (s ? { ...s, stage: 'embedding' } : s)),
        900,
      );

      try {
        const result =
          input instanceof File
            ? await uploadFile(sessionId, input)
            : await ingestText(sessionId, input.text, input.title);
        setDocuments((previous) => [result.document, ...previous]);
        setNotices(result.notes);
        return result.document;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Upload failed.');
      } finally {
        clearTimeout(toEmbedding);
        setUploading(null);
      }
    },
    [sessionId],
  );

  const remove = useCallback(
    async (id: string) => {
      const snapshot = documents;
      setDocuments((previous) => previous.filter((d) => d.id !== id));
      try {
        await deleteDocument(sessionId, id);
      } catch (cause) {
        setDocuments(snapshot); // put it back; the delete did not happen
        setError(cause instanceof Error ? cause.message : 'Delete failed.');
      }
    },
    [documents, sessionId],
  );

  return {
    documents,
    uploading,
    error,
    notices,
    loaded,
    ingest,
    remove,
    refresh,
    setError,
    dismissNotices: () => setNotices([]),
  };
}
