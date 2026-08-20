'use client';

import {
  BookOpen,
  Eye,
  TriangleAlert,
  FileText,
  Layers,
  PlusCircle,
  Trash2,
  X,
} from 'lucide-react';
import { ThemeToggle } from './ThemeToggle';
import { UploadZone } from './UploadZone';
import type { UploadState } from '@/hooks/useDocuments';
import type { DocumentRecord } from '@/lib/types';

const REPO_URL = 'https://github.com/kannan-santharam/DocMind';

/** lucide-react v1 dropped brand marks, so the GitHub logo is inlined. */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

const KIND_LABEL: Record<string, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  text: 'TXT',
  markdown: 'MD',
  paste: 'TEXT',
};

export function Sidebar({
  documents,
  uploading,
  error,
  notices,
  onFile,
  onText,
  onDelete,
  onNewSession,
  onDismissError,
  onDismissNotices,
  trusted,
  onClose,
}: {
  documents: DocumentRecord[];
  uploading: UploadState | null;
  error: string | null;
  onFile: (file: File) => void;
  onText: (text: string, title: string) => void;
  onDelete: (id: string) => void;
  onNewSession: () => void;
  onDismissError: () => void;
  notices?: string[];
  onDismissNotices?: () => void;
  trusted?: boolean;
  onClose?: () => void;
}) {
  const totalPassages = documents.reduce((sum, doc) => sum + doc.chunk_count, 0);

  return (
    <aside className="flex h-full w-full flex-col border-r border-[var(--border-card)] bg-[var(--bg-card)]">
      <div className="flex items-center gap-2.5 border-b border-[var(--border-card)] px-4 py-3.5">
        <div className="relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-xl">
          <span className="tech-gradient-bg absolute inset-0" />
          <Layers className="relative h-4 w-4 text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-brand-gradient text-sm font-extrabold">DocMind</h1>
          <p className="truncate text-[0.65rem] text-[var(--text-muted)]">
            {trusted ? 'Ask about Kannan Santharam' : 'Agentic RAG · Gemini + pgvector'}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close sidebar"
            className="rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-card-hover)] lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
        <UploadZone onFile={onFile} onText={onText} uploading={uploading} />

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-2.5 py-2">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-danger)]" />
            <p className="min-w-0 flex-1 text-[0.7rem] leading-relaxed text-[var(--text-body)]">
              {error}
            </p>
            <button
              type="button"
              onClick={onDismissError}
              aria-label="Dismiss error"
              className="text-[var(--text-muted)] hover:text-[var(--text-title)]"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {notices && notices.length > 0 && (
          <div className="space-y-1.5 rounded-xl border border-[var(--border-gold)] bg-[var(--color-cyan)]/8 px-2.5 py-2">
            <div className="flex items-start gap-2">
              <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-cyan)]" />
              <p className="min-w-0 flex-1 text-[0.68rem] font-bold text-[var(--text-title)]">
                Indexed, with gaps
              </p>
              <button
                type="button"
                onClick={onDismissNotices}
                aria-label="Dismiss"
                className="text-[var(--text-muted)] hover:text-[var(--text-title)]"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {notices.map((notice) => (
              <p key={notice} className="pl-5 text-[0.68rem] leading-relaxed text-[var(--text-sub)]">
                {notice}
              </p>
            ))}
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-[0.65rem] font-bold tracking-wider text-[var(--text-muted)] uppercase">
              Knowledge base
            </span>
            {totalPassages > 0 && (
              <span className="font-mono text-[0.65rem] text-[var(--color-emerald)]">
                {totalPassages} passages
              </span>
            )}
          </div>

          {documents.length === 0 ? (
            <p className="px-1 text-[0.7rem] leading-relaxed text-[var(--text-muted)]">
              Nothing indexed yet. Upload a document and the agent will search it before
              answering.
            </p>
          ) : (
            <ul className="space-y-1">
              {documents.map((doc) => (
                <li
                  key={doc.id}
                  className="group flex items-center gap-2 rounded-lg border border-transparent px-2 py-2 transition-colors hover:border-[var(--border-card)] hover:bg-[var(--bg-card-hover)]"
                >
                  {doc.is_public ? (
                    <BookOpen className="h-3.5 w-3.5 shrink-0 text-[var(--color-violet)]" />
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--color-cyan)]" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-[var(--text-title)]">
                      {doc.filename}
                    </p>
                    <p className="text-[0.65rem] text-[var(--text-muted)]">
                      {doc.is_public ? 'Preloaded' : (KIND_LABEL[doc.source_kind] ?? doc.source_kind)}
                      {doc.page_count ? ` · ${doc.page_count}p` : ''} · {doc.chunk_count} passages
                    </p>
                  </div>
                  {/* A preloaded document is shared, not the visitor's to delete: the
                      API would no-op and the sidebar would show a phantom removal. */}
                  {!doc.is_public && (
                    <button
                      type="button"
                      onClick={() => onDelete(doc.id)}
                      aria-label={`Remove ${doc.filename}`}
                      className="shrink-0 rounded p-1 text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100 hover:text-[var(--color-danger)] focus-visible:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="space-y-2 border-t border-[var(--border-card)] px-3 py-3">
        <button
          type="button"
          onClick={onNewSession}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--border-card)] py-2 text-xs font-semibold text-[var(--text-sub)] transition-colors hover:border-[var(--border-accent)] hover:text-[var(--text-title)]"
        >
          <PlusCircle className="h-3.5 w-3.5" />
          New session
        </button>

        <div className="flex items-center justify-between">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[0.7rem] font-semibold text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-title)]"
          >
            <GithubMark className="h-3.5 w-3.5" />
            Source
          </a>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
