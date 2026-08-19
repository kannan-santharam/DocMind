'use client';

import { useEffect, type ReactNode } from 'react';
import { ArrowDown, RotateCcw, Sliders, Thermometer, X, Zap } from 'lucide-react';
import type { ModelInfo } from '@/lib/models';
import { DEFAULT_SETTINGS, LIMITS, type ChatSettings } from '@/lib/settings';

/**
 * The knobs, with their reasoning attached.
 *
 * Every control carries three lines: what it is, why it exists, and what
 * changing it will actually do to the next answer. A settings drawer that only
 * lists parameter names teaches nothing — the explanation is the feature, and it
 * is what turns "I built a RAG app" into "I understand which knobs matter".
 */

function Knob({
  title,
  value,
  what,
  why,
  effect,
  children,
}: {
  title: string;
  value: string;
  what: string;
  why: string;
  effect: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-[var(--border-card)] px-4 py-4 last:border-b-0">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-bold text-[var(--text-title)]">{title}</h3>
        <span className="shrink-0 font-mono text-[0.7rem] font-semibold text-[var(--color-cyan)]">
          {value}
        </span>
      </div>
      <p className="mb-3 text-[0.7rem] leading-relaxed text-[var(--text-muted)]">{what}</p>
      {children}
      <dl className="mt-3 space-y-1.5">
        <div>
          <dt className="text-[0.62rem] font-bold tracking-wider text-[var(--color-violet)] uppercase">
            Why it exists
          </dt>
          <dd className="text-[0.7rem] leading-relaxed text-[var(--text-sub)]">{why}</dd>
        </div>
        <div>
          <dt className="text-[0.62rem] font-bold tracking-wider text-[var(--color-emerald)] uppercase">
            Turn it up / down
          </dt>
          <dd className="text-[0.7rem] leading-relaxed text-[var(--text-sub)]">{effect}</dd>
        </div>
      </dl>
    </section>
  );
}

export function SettingsPanel({
  open,
  settings,
  models,
  onChange,
  onClose,
}: {
  open: boolean;
  settings: ChatSettings;
  models: ModelInfo[];
  onChange: (next: ChatSettings) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) =>
    onChange({ ...settings, [key]: value });

  const isDefault = JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS);
  const selected = models.find((model) => model.id === settings.model);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
      />

      <div className="relative flex h-full w-[92vw] max-w-md flex-col border-l border-[var(--border-card)] bg-[var(--bg-card)] shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--border-card)] px-4 py-3">
          <Sliders className="h-4 w-4 text-[var(--color-cyan)]" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-bold text-[var(--text-title)]">Retrieval controls</h2>
            <p className="text-[0.65rem] text-[var(--text-muted)]">
              Change these, ask the same question again, watch the trace differ.
            </p>
          </div>
          {!isDefault && (
            <button
              type="button"
              onClick={() => onChange(DEFAULT_SETTINGS)}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[0.7rem] font-semibold text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-title)]"
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-card-hover)] hover:text-[var(--text-title)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {/* ---------------- Model (chosen by the composer) ---------------- */}
          <Knob
            title="Model"
            value={settings.model === 'auto' ? 'Auto' : (selected?.label ?? settings.model)}
            what="Which Gemini model runs the agent loop — deciding when to search, what to search for, and how to write the answer from what comes back. Pick it from the dropdown next to the message box."
            why="Free-tier quotas differ per model by more than an order of magnitude, and some of the newest models allow only 20 requests per day. Auto tries them in order and falls through on failure, so one exhausted quota does not take the demo down."
            effect="Pin a model to compare how each behaves on the same question — the smaller ones search less thoughtfully. A pinned model is never silently substituted: if it is rate-limited you get an error naming it, because observing that model is the entire point of pinning."
          >
            <button
              type="button"
              onClick={onClose}
              className="flex w-full items-center gap-2 rounded-lg border border-[var(--border-card)] px-2.5 py-2 text-left transition-colors hover:border-[var(--border-accent)]"
            >
              <Zap className="h-3.5 w-3.5 shrink-0 text-[var(--color-cyan)]" />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-bold text-[var(--text-title)]">
                  {settings.model === 'auto'
                    ? `Auto — ${models.length} models in order`
                    : (selected?.label ?? settings.model)}
                </span>
                <span className="block text-[0.65rem] text-[var(--text-muted)]">
                  {settings.model === 'auto'
                    ? 'Change it in the dropdown beside the message box'
                    : (selected?.quota ?? 'Pinned')}
                </span>
              </span>
              <ArrowDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
            </button>
          </Knob>

          {/* ---------------- Top-k ---------------- */}
          <Knob
            title="Passages per search (top-k)"
            value={settings.topK == null ? 'Agent decides' : String(settings.topK)}
            what="How many passages each search pulls back from the vector index and hands to the model as evidence."
            why="Left alone, the agent picks this itself per search — a broad question asks for more context, a narrow one for less. That choice is part of what makes this agentic rather than a fixed pipeline, so overriding it is opt-in."
            effect="Lower means sharper, less padding, and a real risk the answer is missing something — pinned to 2, the agent tends to compensate by searching repeatedly until it runs out of turns, which you can watch in the trace. Higher means more coverage but a diluted prompt: past roughly 10 passages the model starts weighting the irrelevant ones as if they mattered."
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => set('topK', settings.topK == null ? 6 : null)}
                className={`shrink-0 rounded-lg border px-2 py-1 text-[0.65rem] font-bold transition-colors ${
                  settings.topK == null
                    ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-cyan)]'
                    : 'border-[var(--border-card)] text-[var(--text-muted)]'
                }`}
              >
                Auto
              </button>
              <input
                type="range"
                min={LIMITS.topK.min}
                max={LIMITS.topK.max}
                step={1}
                value={settings.topK ?? 6}
                onChange={(event) => set('topK', Number(event.target.value))}
                className="h-1 flex-1 cursor-pointer accent-[var(--color-primary)]"
              />
            </div>
          </Knob>

          {/* ---------------- Threshold ---------------- */}
          <Knob
            title="Relevance floor"
            value={settings.threshold.toFixed(2)}
            what="The minimum cosine similarity a passage needs to be returned at all. Anything below this is dropped before the model ever sees it."
            why="Vector search always returns its nearest neighbours, even when nothing is genuinely close. Without a floor, a question the document does not answer still gets six confident-looking passages — and the model will try to answer from them instead of saying it does not know."
            effect="Raise it to force honest 'not in the document' answers. Real matches here score roughly 0.47 to 0.78, so past about 0.5 you will reject genuine hits and retrieval will look broken. That failure mode is the reason the slider stops where it does."
          >
            <input
              type="range"
              min={LIMITS.threshold.min}
              max={LIMITS.threshold.max}
              step={LIMITS.threshold.step}
              value={settings.threshold}
              onChange={(event) => set('threshold', Number(event.target.value))}
              className="h-1 w-full cursor-pointer accent-[var(--color-primary)]"
            />
            <div className="mt-1 flex justify-between font-mono text-[0.6rem] text-[var(--text-muted)]">
              <span>0.00 — everything</span>
              <span>0.50 — strict</span>
            </div>
          </Knob>

          {/* ---------------- Agent turns ---------------- */}
          <Knob
            title="Agent turns"
            value={`${settings.maxTurns} max`}
            what="How many rounds the model may act for before it must produce an answer. Each round is one round trip in which it either calls tools — possibly several in parallel — or writes prose."
            why="This is the budget for self-correction. When a first search comes back thin, a second turn lets the agent rewrite the query and try different wording instead of answering from bad evidence. The final turn is always sent without tools, so the model has to answer rather than call one more tool there is no budget to run."
            effect="Set it to 2 and the agent gets one round of searching before it must answer — the closest this app comes to a fixed RAG pipeline, and a fair way to see what the loop is buying. Raise it and watch the trace grow follow-up queries on questions whose wording does not match the document's. Note a single round can still contain several searches: the model is allowed to fire them in parallel."
          >
            <input
              type="range"
              min={LIMITS.maxTurns.min}
              max={LIMITS.maxTurns.max}
              step={1}
              value={settings.maxTurns}
              onChange={(event) => set('maxTurns', Number(event.target.value))}
              className="h-1 w-full cursor-pointer accent-[var(--color-primary)]"
            />
            <div className="mt-1 flex justify-between font-mono text-[0.6rem] text-[var(--text-muted)]">
              <span>2 — one round</span>
              <span>5 — can refine</span>
            </div>
          </Knob>

          {/* ---------------- The knob that isn't here ---------------- */}
          <section className="px-4 py-4">
            <div className="flex items-start gap-2 rounded-xl border border-[var(--border-card)] bg-[var(--bg-inner)] p-3">
              <Thermometer className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
              <div>
                <h3 className="text-xs font-bold text-[var(--text-title)]">
                  Why there is no temperature slider
                </h3>
                <p className="mt-1 text-[0.7rem] leading-relaxed text-[var(--text-muted)]">
                  Google&apos;s guidance for Gemini 3 is to leave temperature at its default of
                  1.0 — the reasoning engine is tuned for it, and lowering it can cause looping or
                  degraded performance. The usual RAG instinct is to turn it down for factual
                  answers; that is the wrong lever here. Grounding comes from the passages above
                  and the system instruction. If an answer drifts, the fix is a higher relevance
                  floor, not a colder sampler.
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
