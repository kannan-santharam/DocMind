/**
 * Retrieval and agent settings the visitor can change.
 *
 * Shared by the browser and the route handler. The browser clamps so the UI
 * cannot express an invalid value; the server clamps again because the browser
 * is not a trustworthy source — and because an unbounded `maxTurns` would let
 * one visitor burn the whole day's model quota in a handful of requests.
 */

export interface ChatSettings {
  /** A model id, or 'auto' for the fallback chain. */
  model: string;
  /** Passages per search, or null to let the agent decide per search. */
  topK: number | null;
  /** Minimum cosine similarity for a passage to be returned at all. */
  threshold: number;
  /** How many model turns the agent may take before it must answer. */
  maxTurns: number;
}

/**
 * Whether the retrieval controls drawer is reachable from the UI.
 *
 * Off for now. The settings still travel the full path — browser to route
 * handler, clamped at both ends — so turning this back on is a one-line change
 * rather than a rebuild. While it is off, stored retrieval values are ignored in
 * favour of the defaults: settings nobody can see or change should not be
 * silently shaping answers.
 */
export const SHOW_RETRIEVAL_CONTROLS = false;

export const DEFAULT_SETTINGS: ChatSettings = {
  model: 'auto',
  topK: null,
  threshold: 0.25,
  maxTurns: 5,
};

export const LIMITS = {
  topK: { min: 1, max: 12 },
  /**
   * Capped at 0.5 on purpose. Measured top-match scores on real questions run
   * 0.47–0.78, so a threshold above 0.5 silently returns nothing for most
   * genuine queries and reads as "retrieval is broken".
   */
  threshold: { min: 0, max: 0.5, step: 0.05 },
  /**
   * Floored at 2, not 1. The final turn is deliberately sent without tools so
   * the model must answer rather than call one more tool it has no budget to
   * run — so a maximum of 1 would mean the agent could never search at all.
   * Two turns is "search once, then answer".
   */
  maxTurns: { min: 2, max: 5 },
} as const;

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function normaliseSettings(input: unknown): ChatSettings {
  const raw = (input ?? {}) as Partial<ChatSettings>;

  return {
    model: typeof raw.model === 'string' ? raw.model : DEFAULT_SETTINGS.model,
    topK:
      raw.topK == null
        ? null
        : Math.round(clampNumber(raw.topK, LIMITS.topK.min, LIMITS.topK.max, 6)),
    threshold: clampNumber(
      raw.threshold,
      LIMITS.threshold.min,
      LIMITS.threshold.max,
      DEFAULT_SETTINGS.threshold,
    ),
    maxTurns: Math.round(
      clampNumber(raw.maxTurns, LIMITS.maxTurns.min, LIMITS.maxTurns.max, DEFAULT_SETTINGS.maxTurns),
    ),
  };
}

/**
 * Settings restored from storage, with the knobs reset while their UI is hidden.
 * The model choice survives, because its picker is still on screen.
 */
export function restoreSettings(input: unknown): ChatSettings {
  const stored = normaliseSettings(input);
  if (SHOW_RETRIEVAL_CONTROLS) return stored;
  return { ...DEFAULT_SETTINGS, model: stored.model };
}
