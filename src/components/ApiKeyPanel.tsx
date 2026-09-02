'use client';

import { useState } from 'react';
import { ExternalLink, Eye, EyeOff, KeyRound, LoaderCircle, ShieldCheck, TriangleAlert } from 'lucide-react';

import { checkApiKey, storeApiKey } from '@/lib/client';

const STEPS = [
  {
    title: 'Open Google AI Studio',
    body: 'Sign in with any Google account. There is no billing step and no credit card.',
  },
  {
    title: 'Click "Create API key"',
    body: 'Pick an existing Google Cloud project or let it make one for you. The key appears immediately.',
  },
  {
    title: 'Copy it and paste it below',
    body: 'DocMind checks it against Google before saving, so a half-copied key is caught here rather than by your first question.',
  },
];

/**
 * Bring-your-own-key setup, shown to visitors at the public URL.
 *
 * The honest reason is worth stating on the panel rather than hiding behind
 * "configuration required": a single free-tier Gemini key allows on the order of
 * a thousand embedding requests a day, and document upload is the expensive half
 * of a RAG app. A handful of visitors indexing PDFs would exhaust it for
 * everyone, including the copy of this app embedded in the portfolio. Asking for
 * a key that is free and takes a minute is a better trade than a demo that is
 * broken by mid-morning.
 */
export function ApiKeyPanel({
  sessionId,
  reason,
  onSaved,
  onCancel,
}: {
  sessionId: string;
  /** Server-supplied explanation when a stored key stopped working. */
  reason?: string | null;
  onSaved: (key: string) => void;
  /**
   * Present only when a working key is already stored and the visitor opened this
   * to replace it. Without a way back, "Change" would be a one-way door out of a
   * working session.
   */
  onCancel?: () => void;
}) {
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const key = value.trim();
    if (!key || checking) return;

    setChecking(true);
    setError(null);
    try {
      // Verified before it is stored, so a truncated paste is caught here rather
      // than surfacing later as a question that mysteriously fails.
      const result = await checkApiKey(sessionId, key);
      if (!result.valid) {
        setError(result.error ?? 'That key was rejected.');
        return;
      }
      storeApiKey(key);
      onSaved(key);
    } catch {
      setError('Could not reach the server to check the key. Try again in a moment.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col px-4 py-10">
      <div className="mb-5 flex items-center gap-3">
        <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl">
          <span className="tech-gradient-bg absolute inset-0" />
          <KeyRound className="relative h-5 w-5 text-white" />
        </div>
        <div className="min-w-0">
          <h2 className="text-brand-gradient text-xl font-extrabold sm:text-2xl">
            Add a free Gemini API key
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            Takes about a minute · no billing details
          </p>
        </div>
      </div>

      {/**
        * Framed as shared-versus-yours, not as scarcity.
        *
        * An earlier draft said a thousand requests a day was "enough for a few
        * visitors and no more". True of a shared key, and precisely the wrong thing
        * to tell the person being asked to fetch one — they read it as "this
        * allowance is tiny, so mine will run out too" and give up. The allowance is
        * per key: stretched across every visitor it is nothing, and to one person
        * it is plenty. Giving the arithmetic lets them work that out rather than
        * take our word for it.
        */}
      <p className="text-sm leading-relaxed text-[var(--text-sub)]">
        DocMind runs on Google&apos;s Gemini API, and every free key comes with its own daily
        allowance. The trouble with a public demo is that one shared key means every visitor
        draws from the same pool — a handful of uploads and there is nothing left for whoever
        arrives next.
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[var(--text-sub)]">
        On <strong className="text-[var(--text-title)]">your</strong> key the allowance is yours
        alone, and for one person it goes a long way: indexing a document costs at most 80
        requests out of roughly a thousand a day, and asking a question costs one or two. Free,
        no card, and yours to revoke whenever you like.
      </p>

      {reason && (
        <div className="mt-4 flex items-start gap-2 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-xs leading-relaxed text-[var(--text-body)]">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-[var(--color-danger)]" />
          <span>{reason}</span>
        </div>
      )}

      <ol className="mt-6 space-y-2.5">
        {STEPS.map((step, index) => (
          <li
            key={step.title}
            className="flex gap-3 rounded-xl border border-[var(--border-card)] bg-[var(--bg-card)] p-3.5"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-primary)] text-[0.65rem] font-bold text-white">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="text-xs font-bold text-[var(--text-title)]">{step.title}</p>
              <p className="mt-0.5 text-[0.7rem] leading-relaxed text-[var(--text-muted)]">
                {step.body}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <a
        href="https://aistudio.google.com/apikey"
        target="_blank"
        rel="noreferrer noopener"
        className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-xs font-bold text-white transition-colors hover:bg-[var(--color-primary-hover)]"
      >
        Get a key at aistudio.google.com
        <ExternalLink className="h-3.5 w-3.5" />
      </a>

      {/**
        * A real <form>, for three reasons rather than to satisfy the console.
        * Enter-to-submit becomes native instead of a hand-rolled keydown handler,
        * assistive tech gets proper form semantics, and browsers stop treating a
        * lone password field as a stray input.
        *
        * `preventDefault` is load-bearing, not boilerplate: a form left to submit
        * natively performs a GET and puts the key in the URL — the one place a
        * credential must never go, and the exact leak the rest of this file is
        * built to avoid.
        */}
      <form
        className="mt-6"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label
          htmlFor="gemini-key"
          className="mb-1.5 block text-[0.7rem] font-bold text-[var(--text-title)]"
        >
          Paste your key
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            {/**
              * A text input masked with CSS, not `type="password"`.
              *
              * An API key is not a password, and saying it is invites every browser
              * heuristic built for login forms: the offer to save it to a synced
              * password manager, and Chrome's insistence that the form is missing a
              * username field. Adding a hidden username to quiet that would be the
              * wrong fix — it is the very thing that tells a password manager to
              * store this as a credential.
              *
              * `-webkit-text-security` is supported across Chrome, Edge, Safari and
              * Firefox 132+. The masking is a shoulder-surfing courtesy rather than a
              * security control — there is a reveal toggle beside it, and the sidebar
              * shows the last four characters — so a browser that ignores the property
              * costs the visitor nothing they had not already opted into.
              *
              * `spellCheck` off matters more here than it looks: Chrome's enhanced
              * spell check uploads the contents of text fields.
              */}
            <input
              id="gemini-key"
              type="text"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Paste the key from AI Studio…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              className={`w-full rounded-xl border border-[var(--border-card)] bg-[var(--bg-card)] px-3 py-2.5 pr-10 font-mono text-xs text-[var(--text-title)] outline-none transition-colors focus:border-[var(--color-primary)] ${
                reveal ? '' : '[-webkit-text-security:disc]'
              }`}
            />
            <button
              type="button"
              onClick={() => setReveal(!reveal)}
              aria-label={reveal ? 'Hide key' : 'Show key'}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--text-muted)] transition-colors hover:text-[var(--text-title)]"
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <button
            type="submit"
            disabled={!value.trim() || checking}
            className="flex items-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 py-2.5 text-xs font-bold text-white transition-colors hover:bg-[var(--color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checking ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
            {checking ? 'Checking…' : 'Verify & save'}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-xl border border-[var(--border-card)] px-3 py-2.5 text-xs font-semibold text-[var(--text-muted)] transition-colors hover:text-[var(--text-title)]"
            >
              Cancel
            </button>
          )}
        </div>

        {error && (
          <p className="mt-2 text-[0.7rem] leading-relaxed text-[var(--color-danger)]">{error}</p>
        )}
      </form>

      <div className="mt-5 flex items-start gap-2 rounded-xl border border-[var(--border-card)] bg-[var(--bg-card)] p-3.5">
        <ShieldCheck className="mt-px h-4 w-4 shrink-0 text-[var(--color-cyan)]" />
        <div className="text-[0.7rem] leading-relaxed text-[var(--text-muted)]">
          <p className="font-bold text-[var(--text-title)]">Where your key goes</p>
          <p className="mt-1">
            It is stored in this browser&apos;s local storage and sent with each question, in a
            request header rather than a URL, so it stays out of server logs. It is never written to
            the database and never attached to a trace. Remove it any time from the sidebar, or
            revoke it in AI Studio — that revokes it everywhere, which is the guarantee worth having.
          </p>
        </div>
      </div>
    </div>
  );
}
