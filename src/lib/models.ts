/**
 * The models this app is allowed to call.
 *
 * This list is an allowlist, not a suggestion. The model id is interpolated into
 * the Gemini request URL, so a value arriving from the browser is checked by
 * exact membership here — never sanitised, never pattern-matched. A crafted id
 * containing `?` or `#` could otherwise restructure the URL and leak the API key
 * into someone else's query string.
 *
 * Every entry was probed against the live API with a tool-calling request. The
 * quota notes are measured where a 429 exposed the number and marked as
 * unmeasured where it did not — free-tier limits differ per model by more than
 * an order of magnitude and are the real constraint on a public demo.
 */

export interface ModelInfo {
  id: string;
  label: string;
  /** One line on when this model is the right pick. */
  blurb: string;
  /** What is known about its free-tier daily allowance. */
  quota: string;
  measured: boolean;
}

export const MODELS: ModelInfo[] = [
  {
    id: 'gemini-flash-latest',
    label: 'Flash (latest)',
    blurb: 'Stable alias that tracks the current production Flash model. The default first choice.',
    quota: 'Free-tier daily cap not yet observed on this key',
    measured: false,
  },
  {
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    blurb: 'Newest pinned Flash release. Strongest reasoning of the set on multi-step tool use.',
    quota: 'Free-tier daily cap not yet observed on this key',
    measured: false,
  },
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    blurb: 'Previous pinned Flash release. Answers here are near-identical to 3.7.',
    quota: '20 requests/day on the free tier — measured',
    measured: true,
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    blurb: 'Older pinned release, kept as extra fallback headroom.',
    quota: 'Free-tier daily cap not yet observed on this key',
    measured: false,
  },
  {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash Lite',
    blurb: 'Smallest and fastest. Weaker at deciding when to search, but the most generous quota.',
    quota: 'Largest free-tier allowance of the set',
    measured: false,
  },
];

/** Auto mode order: capable first, most-generous quota last. */
export const CHAT_MODELS = MODELS.map((model) => model.id);

export function isAllowedModel(value: unknown): value is string {
  return typeof value === 'string' && CHAT_MODELS.includes(value);
}

/**
 * Which models a request may use. An explicit pick is honoured on its own — no
 * silent substitution, because the whole point of choosing is to see that
 * model's behaviour. Auto gets the full chain.
 */
export function resolveModels(requested: unknown): string[] {
  return isAllowedModel(requested) ? [requested] : CHAT_MODELS;
}
