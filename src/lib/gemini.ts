import { CHAT_MODELS } from './models';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

export const EMBED_MODEL = 'gemini-embedding-001';

/**
 * gemini-embedding-001 returns 3072 dimensions by default. It is a Matryoshka
 * model, so a 768-dim prefix is a valid (slightly lossy) embedding — information
 * is front-loaded by importance, which is what makes truncation supported rather
 * than destructive. Verified against the live API: outputDimensionality 768 /
 * 1536 / 3072 all return exactly that.
 *
 * On 768 specifically: pgvector's `vector` type indexes up to 2000 dimensions
 * with HNSW, so vector(3072) could not be indexed — but `halfvec` indexes up to
 * 4000, so halfvec(3072) was available and not taken. The reason is cost, not
 * impossibility: 3072 bytes per vector against 6144, with distance computation
 * scaling to match, over a corpus where the dropped precision has nothing to
 * disambiguate.
 */
export const EMBED_DIM = 768;

/** Ceiling on one embedding call. Measured round trips are under a second. */
const EMBED_TIMEOUT_MS = 15_000;

// --- Gemini REST payload shapes (only the fields this app touches) -----------

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  /** Gemini 3 returns an opaque signature on tool calls; it must be echoed back. */
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: unknown };
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// --- Embeddings ---------------------------------------------------------------

type EmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

/**
 * The credential a call runs on, plus the label its quota is tracked under.
 *
 * Passed explicitly rather than read from the environment inside these functions,
 * because at the public URL the key belongs to the visitor, not to this
 * deployment. See `lib/apiKey.ts`.
 */
export interface Credential {
  key: string;
  fingerprint: string;
}

/**
 * `x-goog-api-key` rather than `?key=`.
 *
 * Both authenticate identically, but a query string is the part of a request that
 * ends up in access logs, error strings and proxy traces. When the key belongs to
 * a visitor rather than to this deployment, keeping it out of the URL is the
 * difference between handling someone's credential carefully and leaking it into
 * infrastructure neither of us controls.
 */
function authHeaders(credential: Credential): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-goog-api-key': credential.key };
}

async function embedOnce(
  credential: Credential,
  text: string,
  taskType: EmbedTask,
  title?: string,
) {
  /**
   * The same hang, on the other endpoint.
   *
   * `withRetry` retries failures, but a request that never completes is not a
   * failure it can see — so a stalled embed would hold an upload open until the
   * function died. Non-streaming, so a single total timeout is enough here; the
   * retry wrapper then treats the abort as a normal attempt failure and tries
   * again.
   */
  const res = await fetch(
    `${API_ROOT}/${EMBED_MODEL}:embedContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      headers: authHeaders(credential),
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBED_DIM,
        ...(title ? { title } : {}),
      }),
    },
  );

  if (!res.ok) {
    // Status and Google's own retry hint, not the raw body.
    //
    // This message reaches a client response and a Langfuse trace. An unbounded
    // slice of a third party's error text is the wrong thing to forward into
    // either: it can echo request details, and on a visitor's key those details
    // are theirs, not ours. `retryDelayMs` still reads the wait from the body
    // here, where it is in scope, so the useful part survives.
    const body = await res.text();
    const wait = retryDelayMs(body);
    const err = new Error(
      `Embedding failed (${res.status})${wait ? `; Google asked to retry in ${Math.ceil(wait / 1000)}s` : ''}.`,
    );
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  const json = (await res.json()) as { embedding?: { values: number[] } };
  const values = json.embedding?.values;
  if (!values?.length) throw new Error('Embedding response contained no vector.');
  return values;
}

/**
 * Truncating a Matryoshka embedding below its native size leaves it un-normalised,
 * which skews cosine distance. Re-normalise before it reaches pgvector.
 */
function l2Normalise(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  return norm > 0 ? vector.map((v) => v / norm) : vector;
}

/**
 * Free-tier embedding quota, measured against the live API rather than guessed:
 * `EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier`, value 100.
 * Firing 220 requests at concurrency 5 produced a 429 on request 99 and then
 * failed everything behind it, so the client paces itself below the ceiling.
 */
const EMBED_RPM_LIMIT = 100;
const EMBED_RPM_BUDGET = 85; // headroom for anything else sharing the key
const RATE_WINDOW_MS = 60_000;

export class QuotaExhaustedError extends Error {}

/**
 * How long one model gets to start responding before the cascade moves on.
 *
 * The fallback chain was written for models that *fail* — a 429, a 5xx, a refused
 * connection. It did not cover the failure that actually happened: a model that
 * accepts the request and then never answers. With no timeout the loop waits on
 * the first candidate forever, the other four are never tried, and the whole thing
 * dies when the serverless function hits `maxDuration` — a 504 with nothing
 * streamed, from a system whose entire point is having somewhere else to go.
 *
 * Observed live: `gemini-flash-latest` and `gemini-3.7-flash` both hung
 * indefinitely while the other three answered the same prompt in 1.5–4.2s. Six
 * seconds sits clear of the healthy range and keeps the cost of discovering a dead
 * model low, since on serverless most instances are cold and rediscover it.
 *
 * This bounds time-to-response, not the answer. The timer is cleared the moment
 * headers arrive, so a long reply streams for as long as it needs.
 */
const MODEL_RESPONSE_TIMEOUT_MS = 6_000;

/**
 * How long a stream may go silent mid-answer before the model is written off.
 *
 * More generous than the first-response budget: a model that has started
 * answering may legitimately pause while it thinks between tool calls.
 */
const STREAM_IDLE_TIMEOUT_MS = 20_000;

/**
 * Ceiling on the whole cascade, leaving room under the 60s function limit.
 *
 * Five candidates that each hang cost 5 × the response timeout before the loop
 * even reports failure, and that arithmetic is what turns one slow model into a
 * platform timeout with nothing streamed. Once this passes, remaining candidates
 * are skipped and the caller gets a real error instead of a 504.
 */
const CASCADE_BUDGET_MS = 40_000;

/**
 * Models known to be rate-limited, and when they are worth trying again.
 *
 * Without this, every request after a model exhausts its daily quota pays a
 * wasted round trip to that model before falling through. With three models in
 * the chain that is most of a second added to every answer, all day.
 *
 * Keyed by `fingerprint:model`, not by model. Gemini quotas are per project, so
 * one visitor exhausting their own key says nothing about anyone else's — and a
 * warm serverless instance is shared. Keyed by model alone, the first visitor to
 * run out would silently disable that model for every other visitor and for the
 * portfolio. Keyed by fingerprint alone, the per-model cascade stops working at
 * all, which is the feature this map exists to serve.
 */
const exhaustedUntil = new Map<string, number>();

/** Embedding call timestamps in the last minute, per key, oldest first. */
const recentEmbedCalls = new Map<string, number[]>();

/**
 * Prune expired state and return the calling key's window.
 *
 * The sweep covers *every* entry, not just this one. Pruning only the caller's
 * key is the obvious implementation and leaves the map growing forever: a visitor
 * who uploads once and leaves keeps their array of timestamps for as long as the
 * instance stays warm, because nothing ever calls in under their fingerprint
 * again. Expired cooldowns get the same treatment for the same reason.
 *
 * Both maps hold at most one small entry per key seen in the last minute, so the
 * sweep is over a handful of entries and runs before an embedding call that is
 * about to cost a network round trip regardless.
 */
function pruneWindow(fingerprint: string, now: number): number[] {
  for (const [key, calls] of recentEmbedCalls) {
    while (calls.length && now - calls[0] >= RATE_WINDOW_MS) calls.shift();
    if (!calls.length) recentEmbedCalls.delete(key);
  }
  for (const [key, until] of exhaustedUntil) {
    if (until <= now) exhaustedUntil.delete(key);
  }

  const calls = recentEmbedCalls.get(fingerprint) ?? [];
  recentEmbedCalls.set(fingerprint, calls);
  return calls;
}

/**
 * Sliding-window gate in front of every embedding call.
 *
 * Warm serverless instances reuse this module, so back-to-back ingests on the
 * same instance share the window. `deadline` stops the gate from parking a
 * request past the function's own time limit — better a clear quota message than
 * a silent platform timeout.
 */
async function reserveEmbedSlot(fingerprint: string, deadline: number | undefined) {
  for (;;) {
    const now = Date.now();
    const calls = pruneWindow(fingerprint, now);

    if (calls.length < EMBED_RPM_BUDGET) {
      calls.push(now);
      recentEmbedCalls.set(fingerprint, calls);
      return;
    }

    const waitMs = RATE_WINDOW_MS - (now - calls[0]) + 50;
    if (deadline && now + waitMs > deadline) {
      throw new QuotaExhaustedError(
        `The free Gemini embedding tier allows ${EMBED_RPM_LIMIT} requests per minute and this key has just used them. Wait about ${Math.ceil(waitMs / 1000)}s and upload again.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Gemini reports exactly how long to wait; prefer it over blind backoff. */
function retryDelayMs(message: string): number | null {
  const match = /retry in ([\d.]+)s/i.exec(message);
  return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 4, deadline }: { attempts?: number; deadline?: number } = {},
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      // 429 = quota, 5xx = transient. Anything else is a real bug, not a retry.
      if (status && status !== 429 && status < 500) throw error;
      if (attempt === attempts - 1) break;

      const message = error instanceof Error ? error.message : '';
      const serverWait = status === 429 ? retryDelayMs(message) : null;
      const waitMs = serverWait ?? 400 * 2 ** attempt + Math.random() * 200;

      if (deadline && Date.now() + waitMs > deadline) {
        throw new QuotaExhaustedError(
          serverWait
            ? `Gemini's free embedding quota (${EMBED_RPM_LIMIT}/minute) is exhausted; it frees up in about ${Math.ceil(serverWait / 1000)}s. Try again shortly.`
            : 'Embedding is taking longer than this request can wait. Try again.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  throw lastError;
}

export function embedQuery(credential: Credential, text: string): Promise<number[]> {
  return withRetry(() => embedOnce(credential, text, 'RETRIEVAL_QUERY')).then(l2Normalise);
}

/**
 * gemini-embedding-001 exposes no synchronous batch endpoint, so this fans out
 * single calls with bounded concurrency behind the rate gate above.
 */
export async function embedDocuments(
  credential: Credential,
  texts: string[],
  {
    concurrency = 5,
    title,
    deadline,
  }: { concurrency?: number; title?: string; deadline?: number } = {},
): Promise<number[][]> {
  const out = new Array<number[]>(texts.length);
  let cursor = 0;

  async function worker() {
    while (cursor < texts.length) {
      const index = cursor++;
      await reserveEmbedSlot(credential.fingerprint, deadline);
      const vector = await withRetry(
        () => embedOnce(credential, texts[index], 'RETRIEVAL_DOCUMENT', title),
        { deadline },
      );
      out[index] = l2Normalise(vector);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, texts.length) }, worker),
  );
  return out;
}

// --- Streaming chat completion ------------------------------------------------

export interface StreamTurnOptions {
  /** Whose Gemini quota this turn runs on. */
  credential: Credential;
  contents: GeminiContent[];
  systemInstruction: string;
  tools?: FunctionDeclaration[];
  signal?: AbortSignal;
  /** Candidate models, tried in order. One entry means no fallback. */
  models?: readonly string[];
  /** Called for each text delta as it arrives. */
  onText: (delta: string) => void;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

export interface StreamTurnResult {
  /** Every part the model emitted, in order — push this back as the model turn. */
  parts: GeminiPart[];
  text: string;
  functionCalls: NonNullable<GeminiPart['functionCall']>[];
  model: string;
  usage?: TokenUsage;
}

/**
 * One streamed model turn.
 *
 * Uses `alt=sse` so each chunk is a clean `data:` line rather than a fragment of
 * a giant JSON array. Text is forwarded to `onText` the moment it lands; tool
 * calls are collected and returned for the caller's agent loop to execute.
 */
export async function streamTurn(
  options: StreamTurnOptions,
): Promise<StreamTurnResult> {
  const { contents, systemInstruction, tools, signal, onText, credential } = options;
  const candidates = options.models?.length ? options.models : CHAT_MODELS;

  let lastError: unknown;
  let quotaHit = false;
  /**
   * Tracked apart from `quotaHit` on purpose.
   *
   * Folding a hang into the quota flag tells the visitor "every model has hit its
   * free-tier quota, which resets daily" — advice that sends them away to wait for
   * a reset that was never the problem, and on their own key implies they burned
   * an allowance they have not touched. Different cause, different message.
   */
  let unresponsive = false;
  const cascadeDeadline = Date.now() + CASCADE_BUDGET_MS;

  for (const model of candidates) {
    // Stop walking rather than march the whole list into a platform timeout.
    if (Date.now() > cascadeDeadline && lastError) break;

    // Skip a model known to be rate-limited — but only when there is somewhere
    // else to go. If the visitor pinned one model, try it and report the truth
    // rather than refusing on the strength of a stale timestamp.
    const cooldownKey = `${credential.fingerprint}:${model}`;
    const cooldown = exhaustedUntil.get(cooldownKey);
    if (candidates.length > 1 && cooldown && cooldown > Date.now()) {
      quotaHit = true;
      continue;
    }

    let response: Response;
    // Aborts this attempt if the model does not start responding, while still
    // honouring the caller's own signal when the browser goes away.
    const attempt = new AbortController();
    const timeout = setTimeout(() => attempt.abort(), MODEL_RESPONSE_TIMEOUT_MS);
    const attemptSignal = signal
      ? AbortSignal.any([signal, attempt.signal])
      : attempt.signal;

    try {
      response = await fetch(
        `${API_ROOT}/${model}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          headers: authHeaders(credential),
          signal: attemptSignal,
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: systemInstruction }] },
            ...(tools?.length ? { tools: [{ functionDeclarations: tools }] } : {}),
            /**
             * No temperature override, deliberately. Google's Gemini 3 guidance is
             * to leave it at the default of 1.0: "Do not lower the temperature.
             * Gemini 3's reasoning engine is optimized for 1.0; lowering it may
             * cause looping or degraded performance in complex tasks." Every model
             * in the cascade is Gemini 3.
             *
             * The instinct for RAG is a low temperature to keep answers factual,
             * but grounding here comes from the retrieved passages and the system
             * instruction, not from suppressing sampling. topK / topP are left
             * unset for the same reason.
             */
            generationConfig: { maxOutputTokens: 2048 },
          }),
        },
      );
    } catch (error) {
      clearTimeout(timeout);
      // The caller aborting is not a model failure — stop, do not try the rest.
      if (signal?.aborted) throw error;
      if (attempt.signal.aborted) {
        /**
         * Remember the hang, exactly as a 429 is remembered.
         *
         * Without this the cooldown map only learns about quota errors, so a
         * hanging model is re-tried at the top of the cascade on every turn of the
         * agent loop — measured at 77s for a single answer, paying the same wait
         * again on each turn against the same dead model, which still blows the
         * function's 60s budget. One timeout should cost a request once, not once
         * per turn.
         */
        exhaustedUntil.set(cooldownKey, Date.now() + 60_000);
        unresponsive = true;
        lastError = new Error(
          `${model} did not respond within ${MODEL_RESPONSE_TIMEOUT_MS / 1000}s.`,
        );
      } else {
        lastError = error;
      }
      continue;
    }
    clearTimeout(timeout);

    if (!response.ok || !response.body) {
      const body = await response.text();
      if (response.status === 429) {
        quotaHit = true;
        exhaustedUntil.set(cooldownKey, Date.now() + (retryDelayMs(body) ?? 60_000));
      }
      // Same reasoning as embedOnce: the status is ours to report, the upstream
      // body is not ours to relay. This one ends up in an SSE `error` event
      // rendered in the visitor's browser.
      lastError = new Error(`${model} responded ${response.status}.`);
      continue; // quotas are per-model, so the next one may well succeed
    }

    const parts: GeminiPart[] = [];
    let text = '';
    let usage: TokenUsage | undefined;

    const handleLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;

      let chunk: {
        candidates?: { content?: GeminiContent }[];
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
          thoughtsTokenCount?: number;
        };
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        return; // partial frame; the next read completes it
      }

      // Gemini reports usage on the closing frames; later frames supersede earlier.
      if (chunk.usageMetadata) {
        const meta = chunk.usageMetadata;
        usage = {
          input: meta.promptTokenCount,
          // Thinking tokens are billed as output but reported separately.
          output: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
          total: meta.totalTokenCount,
        };
      }

      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        // Thought summaries are internal reasoning, not answer text.
        if (part.thought) continue;
        parts.push(part);
        if (part.text) {
          text += part.text;
          onText(part.text);
        }
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    /**
     * The headers arriving is not the same as the answer arriving.
     *
     * The response timeout above is cleared once headers land, which leaves the
     * body free to stall forever — the same hang one step later, and the reason
     * bounding only time-to-first-response is not enough. Each read is raced
     * against an idle timer instead, so a stream that stops producing is caught.
     *
     * What happens next depends on whether the visitor has already seen text. With
     * nothing emitted, this model is simply a failure and the cascade moves on.
     * Once tokens are on screen, switching models would splice two different
     * answers together, so the honest move is to stop and say so.
     */
    let stalled = false;
    try {
      for (;;) {
        // The timer is cleared whichever way the race lands. Leaving it pending
        // would queue one live timeout per chunk — harmless to correctness, but on
        // a long answer it is hundreds of them holding the event loop open and
        // keeping a serverless function from freezing.
        let idle: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<'stalled'>((resolve) => {
            idle = setTimeout(() => resolve('stalled'), STREAM_IDLE_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(idle);

        if (chunk === 'stalled') {
          stalled = true;
          break;
        }
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      }
    } finally {
      if (stalled) await reader.cancel().catch(() => undefined);
    }

    if (stalled) {
      exhaustedUntil.set(cooldownKey, Date.now() + 60_000);
      unresponsive = true;
      if (text) {
        throw new Error(
          `${model} stopped streaming part-way through the answer. Please ask again.`,
        );
      }
      lastError = new Error(`${model} opened a stream and then stopped responding.`);
      continue;
    }

    // The last frame often arrives without a trailing newline, which would leave
    // it stranded in the buffer and silently truncate the answer mid-sentence.
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer.trim());

    // Keyed the same way it was set. This read `delete(model)` before keys became
    // fingerprint-scoped, which silently stopped matching anything — a model stayed
    // marked exhausted for its full cooldown even after answering successfully.
    exhaustedUntil.delete(cooldownKey);

    return {
      parts,
      text,
      functionCalls: parts
        .map((p) => p.functionCall)
        .filter((c): c is NonNullable<GeminiPart['functionCall']> => Boolean(c)),
      model,
      usage,
    };
  }

  if (unresponsive && !quotaHit) {
    throw new Error(
      candidates.length === 1
        ? `${candidates[0]} is not responding right now. Switch the model to Auto and the app will try the others.`
        : 'Gemini is not responding at the moment — every model in the fallback chain timed out. This is upstream of the app; please try again shortly.',
    );
  }

  if (quotaHit) {
    throw new QuotaExhaustedError(
      candidates.length === 1
        ? `${candidates[0]} has hit its free-tier quota for now. Switch the model to Auto and the app will fall back to another one.`
        : "Every model in the fallback chain has hit its free-tier quota. This demo runs on Google's free Gemini tier, which resets daily — try again shortly.",
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Every Gemini model in the cascade failed.');
}
