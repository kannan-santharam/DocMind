'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ArrowUp, Sliders, Square } from 'lucide-react';
import { ModelPicker } from './ModelPicker';
import type { ModelInfo } from '@/lib/models';
import { SHOW_RETRIEVAL_CONTROLS } from '@/lib/settings';

const MAX_ROWS_PX = 200;

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  disabled,
  placeholder,
  model,
  models,
  onModelChange,
  onOpenControls,
  settingsSummary,
  tracing,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled: boolean;
  placeholder: string;
  model: string;
  models: ModelInfo[];
  onModelChange: (model: string) => void;
  onOpenControls: () => void;
  /** Non-default retrieval settings, shown as a badge so they are never silently on. */
  settingsSummary: string | null;
  /** True when questions are sent to Langfuse — drives the disclosure below. */
  tracing: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the content up to a cap, then scroll — same feel as ChatGPT/Claude.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!disabled && !isStreaming) onSubmit();
    }
  };

  return (
    <div className="px-4 pb-4">
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-2xl border border-[var(--border-card)] bg-[var(--bg-card)] p-2 shadow-lg transition-colors focus-within:border-[var(--color-primary)]">
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            className="no-scrollbar max-h-[200px] w-full resize-none bg-transparent px-2 py-2 text-[0.9375rem] leading-relaxed text-[var(--text-title)] outline-none placeholder:text-[var(--text-muted)] disabled:opacity-60"
          />

          {/* Model and retrieval controls sit with the message they affect. */}
          <div className="flex items-center gap-1 pt-1">
            <ModelPicker
              value={model}
              models={models}
              onChange={onModelChange}
              disabled={disabled}
            />

            {SHOW_RETRIEVAL_CONTROLS && (
              <button
                type="button"
                onClick={onOpenControls}
                aria-label="Retrieval controls"
                title="Retrieval controls"
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[0.7rem] font-semibold text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-title)]"
              >
                <Sliders className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Controls</span>
              </button>
            )}

            {SHOW_RETRIEVAL_CONTROLS && settingsSummary && (
              <button
                type="button"
                onClick={onOpenControls}
                className="max-w-[10rem] truncate rounded-md bg-[var(--color-primary)]/12 px-1.5 py-0.5 font-mono text-[0.6rem] font-semibold text-[var(--color-cyan)]"
                title="Retrieval settings differ from the defaults"
              >
                {settingsSummary}
              </button>
            )}

            <div className="flex-1" />

            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--bg-pill)] text-[var(--text-title)] transition-colors hover:bg-[var(--bg-card-hover)]"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSubmit}
                disabled={disabled || !value.trim()}
                aria-label="Send message"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#0052ff] to-[#00d2ff] text-white transition-opacity disabled:opacity-35"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <p className="mt-2 text-center text-[0.7rem] leading-relaxed text-[var(--text-muted)]">
          Answers are grounded in your uploaded documents. Enter to send, Shift+Enter for a new
          line.
          {tracing && (
            <>
              {' '}
              Your questions and the retrieved passages are sent to{' '}
              <a
                href="https://langfuse.com"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-[var(--text-title)]"
              >
                Langfuse
              </a>
              , a third-party tracing service, so this demo&apos;s retrieval quality can be
              reviewed.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
