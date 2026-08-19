'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, Menu, Trash2 } from 'lucide-react';
import { ChatView } from '@/components/ChatView';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Composer } from '@/components/Composer';
import { SettingsPanel } from '@/components/SettingsPanel';
import { Sidebar } from '@/components/Sidebar';
import { useChat } from '@/hooks/useChat';
import { useDocuments } from '@/hooks/useDocuments';
import { deleteDocument, getSessionId, resetSessionId } from '@/lib/client';
import type { ModelInfo } from '@/lib/models';
import {
  DEFAULT_SETTINGS,
  restoreSettings,
  SHOW_RETRIEVAL_CONTROLS,
  type ChatSettings,
} from '@/lib/settings';

interface SetupStatus {
  configured: boolean;
  missing: string[];
  tracing?: boolean;
}

const SETTINGS_KEY = 'docmind-settings';

export function ChatApp({ tracing }: { tracing: boolean }) {
  const [sessionId, setSessionId] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [input, setInput] = useState('');
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmNewSession, setConfirmNewSession] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS);

  useEffect(() => {
    setSessionId(getSessionId());

    // Restored through the same clamp the server applies, so a stale or
    // hand-edited localStorage value cannot express an invalid setting.
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) setSettings(restoreSettings(JSON.parse(saved)));
    } catch {
      /* corrupt or unavailable storage — defaults stand */
    }

    void fetch('/api/status')
      .then((r) => r.json())
      .then(setSetup)
      .catch(() => setSetup({ configured: false, missing: ['unreachable'] }));

    void fetch('/api/models')
      .then((r) => r.json())
      .then((payload) => setModels(payload.models ?? []))
      .catch(() => setModels([]));
  }, []);

  const updateSettings = useCallback((next: ChatSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* private browsing */
    }
  }, []);

  const docs = useDocuments(sessionId);
  const chat = useChat(sessionId, settings);

  /** Uploads this visitor owns — the preloaded documents are not theirs to lose. */
  const ownedDocuments = docs.documents.filter((doc) => !doc.is_public);

  const submit = useCallback(
    (text?: string) => {
      const content = (text ?? input).trim();
      if (!content) return;
      setInput('');
      void chat.send(content);
    },
    [chat, input],
  );

  const startNewSession = useCallback(async () => {
    setConfirmNewSession(false);

    // Delete this session's uploads before rotating the id. Rotating alone would
    // leave the rows in Postgres addressable by nobody — invisible in the app,
    // still present in the database, and only cleared whenever purge_expired
    // next runs. The preloaded document is untouched: deletes are scoped to this
    // session.
    if (sessionId) await deleteDocument(sessionId).catch(() => undefined);

    setSessionId(resetSessionId());
    chat.reset();
    setSidebarOpen(false);
    void docs.refresh();
  }, [chat, docs, sessionId]);

  /**
   * Only worth interrupting someone when there is something to lose. With no
   * uploads of their own, "New session" just clears the chat — a confirmation
   * there would be noise that trains people to dismiss the real one.
   */
  const requestNewSession = useCallback(() => {
    if (ownedDocuments.length === 0) {
      void startNewSession();
      return;
    }
    setConfirmNewSession(true);
  }, [ownedDocuments.length, startNewSession]);

  const configWarning = setup && !setup.configured;

  // Only non-default retrieval settings are surfaced. A badge that is always on
  // says nothing; one that appears only when something is tuned is a real signal.
  const settingsSummary =
    [
      settings.topK != null && `k=${settings.topK}`,
      settings.threshold !== DEFAULT_SETTINGS.threshold && `floor ${settings.threshold.toFixed(2)}`,
      settings.maxTurns !== DEFAULT_SETTINGS.maxTurns && `${settings.maxTurns} turns`,
    ]
      .filter(Boolean)
      .join(' · ') || null;

  return (
    <div className="flex h-dvh overflow-hidden bg-[var(--bg-page)]">
      {/* Desktop sidebar */}
      <div className="hidden w-72 shrink-0 lg:block">
        <Sidebar
          documents={docs.documents}
          uploading={docs.uploading}
          error={docs.error}
          notices={docs.notices}
          onDismissNotices={docs.dismissNotices}
          onFile={(file) => void docs.ingest(file)}
          onText={(text, title) => void docs.ingest({ text, title })}
          onDelete={(id) => void docs.remove(id)}
          onNewSession={requestNewSession}
          onDismissError={() => docs.setError(null)}
        />
      </div>

      {/* Mobile drawer */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={() => setSidebarOpen(false)}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <div className="absolute inset-y-0 left-0 w-[85vw] max-w-xs">
            <Sidebar
              documents={docs.documents}
              uploading={docs.uploading}
              error={docs.error}
              notices={docs.notices}
              onDismissNotices={docs.dismissNotices}
              onFile={(file) => void docs.ingest(file)}
              onText={(text, title) => void docs.ingest({ text, title })}
              onDelete={(id) => void docs.remove(id)}
              onNewSession={requestNewSession}
              onDismissError={() => docs.setError(null)}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-card)] bg-[var(--nav-bg)] px-3 py-2.5 backdrop-blur-xl">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open sidebar"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-card-hover)] lg:hidden"
          >
            <Menu className="h-4 w-4" />
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-bold text-[var(--text-title)]">
              {docs.documents.length === 0
                ? 'No documents indexed'
                : ownedDocuments.length === 0
                  ? 'Kannan Santharam — profile, skills & this project'
                  : `${docs.documents.length} documents indexed`}
            </p>
            <p className="truncate text-[0.65rem] text-[var(--text-muted)]">
              tool-calling retrieval agent · answers cite the passages they used
            </p>
          </div>

          {chat.messages.length > 0 && (
            <button
              type="button"
              onClick={chat.reset}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[0.7rem] font-semibold text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--color-danger)]"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Clear chat</span>
            </button>
          )}
        </header>

        {configWarning && (
          <div className="border-b border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-2 text-center text-xs text-[var(--text-body)]">
            Server not configured — missing{' '}
            <span className="font-mono font-bold">{setup.missing.join(', ')}</span>. See{' '}
            <span className="font-mono">.env.example</span>.
          </div>
        )}

        <ChatView
          messages={chat.messages}
          isStreaming={chat.isStreaming}
          hasDocuments={docs.documents.length > 0}
          onlyPreloaded={docs.documents.length > 0 && ownedDocuments.length === 0}
          documentsLoaded={docs.loaded}
          onPickPrompt={(prompt) => submit(prompt)}
        />

        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => submit()}
          onStop={chat.stop}
          isStreaming={chat.isStreaming}
          disabled={!sessionId || Boolean(configWarning)}
          placeholder={
            docs.documents.length === 0
              ? 'Upload a document first, then ask about it…'
              : ownedDocuments.length > 0
                ? 'Ask about your documents…'
                : "Ask about Kannan's experience, or upload a job description…"
          }
          model={settings.model}
          models={models}
          onModelChange={(model) => updateSettings({ ...settings, model })}
          onOpenControls={() => setSettingsOpen(true)}
          settingsSummary={settingsSummary}
          /**
           * Server value first, so the disclosure is in the initial HTML. The
           * page is statically rendered, so that value is fixed at build time —
           * OR-ing in the live status means adding Langfuse keys later starts
           * showing the notice without needing a redeploy.
           */
          tracing={tracing || Boolean(setup?.tracing)}
        />
        <ConfirmDialog
          open={confirmNewSession}
          title="Start a new session?"
          confirmLabel={`Delete and start over`}
          onConfirm={() => void startNewSession()}
          onCancel={() => setConfirmNewSession(false)}
          body={
            <>
              <p>
                Starting a new session removes the{' '}
                <strong className="text-[var(--text-title)]">
                  {ownedDocuments.length} document{ownedDocuments.length === 1 ? '' : 's'}
                </strong>{' '}
                you uploaded and clears this conversation.
              </p>
              <ul className="mt-3 space-y-1.5">
                {ownedDocuments.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center gap-2 rounded-lg border border-[var(--border-card)] bg-[var(--bg-inner)] px-2.5 py-1.5"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--color-cyan)]" />
                    <span className="min-w-0 flex-1 truncate text-[0.72rem] font-semibold text-[var(--text-title)]">
                      {doc.filename}
                    </span>
                    <span className="shrink-0 font-mono text-[0.62rem] text-[var(--text-muted)]">
                      {doc.chunk_count} passages
                    </span>
                  </li>
                ))}
              </ul>
            </>
          }
        />

        <SettingsPanel
          open={SHOW_RETRIEVAL_CONTROLS && settingsOpen}
          settings={settings}
          models={models}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
        />
      </main>
    </div>
  );
}
