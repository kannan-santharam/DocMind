'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Zap } from 'lucide-react';
import type { ModelInfo } from '@/lib/models';

/**
 * Model selector, sitting inside the composer where the model choice belongs —
 * next to the message it affects, not buried in a settings drawer.
 *
 * Opens upward: the composer is pinned to the bottom of the viewport, so a
 * downward menu would open off-screen.
 */
export function ModelPicker({
  value,
  models,
  onChange,
  disabled,
}: {
  value: string;
  models: ModelInfo[];
  onChange: (model: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = models.find((model) => model.id === value);
  const label = value === 'auto' ? 'Auto' : (selected?.label ?? value);

  const choose = (model: string) => {
    onChange(model);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[0.7rem] font-semibold text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-title)] disabled:opacity-50"
      >
        {value === 'auto' && <Zap className="h-3 w-3 text-[var(--color-cyan)]" />}
        <span className="max-w-[9rem] truncate">{label}</span>
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-50 mb-2 max-h-[60vh] w-[19rem] overflow-y-auto rounded-xl border border-[var(--border-card)] bg-[var(--bg-card)] p-1 shadow-2xl"
        >
          <button
            type="button"
            role="option"
            aria-selected={value === 'auto'}
            onClick={() => choose('auto')}
            className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
              value === 'auto' ? 'bg-[var(--color-primary)]/12' : 'hover:bg-[var(--bg-card-hover)]'
            }`}
          >
            <Check
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${value === 'auto' ? 'text-[var(--color-cyan)]' : 'text-transparent'}`}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1 text-xs font-bold text-[var(--text-title)]">
                <Zap className="h-3 w-3 text-[var(--color-cyan)]" />
                Auto
              </span>
              <span className="mt-0.5 block text-[0.65rem] leading-relaxed text-[var(--text-muted)]">
                Tries {models.length} models in order and falls back when one is rate-limited.
              </span>
            </span>
          </button>

          <div className="my-1 border-t border-[var(--border-card)] px-2.5 pt-1.5 pb-1">
            <span className="text-[0.6rem] font-bold tracking-wider text-[var(--text-muted)] uppercase">
              Pin one model
            </span>
          </div>

          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              role="option"
              aria-selected={value === model.id}
              onClick={() => choose(model.id)}
              className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                value === model.id
                  ? 'bg-[var(--color-primary)]/12'
                  : 'hover:bg-[var(--bg-card-hover)]'
              }`}
            >
              <Check
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${value === model.id ? 'text-[var(--color-cyan)]' : 'text-transparent'}`}
              />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-[var(--text-title)]">
                  {model.label}
                </span>
                <span className="mt-0.5 block text-[0.65rem] leading-relaxed text-[var(--text-muted)]">
                  {model.blurb}
                </span>
                <span
                  className={`mt-1 inline-block rounded px-1.5 py-0.5 font-mono text-[0.58rem] ${
                    model.measured
                      ? 'bg-[var(--color-danger)]/12 text-[var(--color-danger)]'
                      : 'bg-[var(--bg-pill)] text-[var(--text-muted)]'
                  }`}
                >
                  {model.quota}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
