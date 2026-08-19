'use client';

import { useCallback, useState } from 'react';
import { TriangleAlert, Check, Copy, Sparkles } from 'lucide-react';
import { AgentTrace } from './AgentTrace';
import { Markdown } from './Markdown';
import { Sources } from './Sources';
import type { ChatMessage } from '@/lib/types';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [text]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy answer"
      className="flex items-center gap-1 rounded-lg px-2 py-1 text-[0.7rem] font-medium text-[var(--text-muted)] opacity-0 transition-all group-hover:opacity-100 hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-title)] focus-visible:opacity-100"
    >
      {copied ? <Check className="h-3 w-3 text-[var(--color-emerald)]" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export function Message({
  message,
  isLast,
  isStreaming,
}: {
  message: ChatMessage;
  isLast: boolean;
  isStreaming: boolean;
}) {
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const streamingThis = isLast && isStreaming;

  const jumpToSource = useCallback(
    (marker: number) => {
      setHighlighted(marker);
      requestAnimationFrame(() => {
        document
          .getElementById(`source-${message.id}-${marker}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      setTimeout(() => setHighlighted(null), 2400);
    },
    [message.id],
  );

  if (message.role === 'user') {
    return (
      <div className="animate-fade-in flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[var(--bg-pill)] px-4 py-2.5 text-[0.9375rem] leading-relaxed whitespace-pre-wrap text-[var(--text-title)]">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in group flex gap-3">
      <div className="relative mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg">
        <span className="tech-gradient-bg absolute inset-0" />
        <Sparkles className="relative h-3.5 w-3.5 text-white" />
      </div>

      <div className="min-w-0 flex-1">
        {message.trace && message.trace.length > 0 && (
          <AgentTrace steps={message.trace} streaming={Boolean(message.content)} />
        )}

        {message.error && (
          <div className="mb-2 flex items-start gap-2 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-3 py-2 text-xs text-[var(--text-body)]">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-danger)]" />
            <span>{message.content}</span>
          </div>
        )}

        {!message.error && (
          <>
            <Markdown content={message.content} onCitationClick={jumpToSource} />
            {streamingThis && !message.content && (
              <p className="gemini-gradient-text text-sm font-semibold">Thinking…</p>
            )}
            {streamingThis && message.content && <span className="stream-caret" />}
          </>
        )}

        {message.citations && (
          <Sources
            citations={message.citations}
            messageId={message.id}
            highlighted={highlighted}
          />
        )}

        {!streamingThis && !message.error && message.content && (
          <div className="mt-1.5 -ml-2 flex items-center gap-1">
            <CopyButton text={message.content} />
            {message.model && (
              <span className="font-mono text-[0.62rem] text-[var(--text-muted)] opacity-0 transition-opacity group-hover:opacity-100">
                {message.model}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
