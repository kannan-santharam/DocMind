import { env } from './env';
import { CHAT_MODELS } from './models';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

export const EMBED_MODEL = 'gemini-embedding-001';

/**
 * gemini-embedding-001 returns 3072 dimensions by default. It is a Matryoshka
 * model, so a 768-dim prefix is a valid (slightly lossy) embedding — and
 * pgvector's HNSW index rejects anything over 2000 dimensions. Verified against
 * the live API: outputDimensionality 768 / 1536 / 3072 all return exactly that.
 */
export const EMBED_DIM = 768;

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

async function embedOnce(text: string, taskType: EmbedTask, title?: string) {
  const res = await fetch(
    `${API_ROOT}/${EMBED_MODEL}:embedContent?key=${env.geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const body = await res.text();
    const err = new Error(`Embedding failed (${res.status}): ${body.slice(0, 300)}`);
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
 * Models known to be rate-limited, and when they are worth trying again.
 *
 * Without this, every request after a model exhausts its daily quota pays a
 * wasted round trip to that model before falling through. With three models in
 * the chain that is most of a second added to every answer, all day.
 */
const exhaustedUntil = new Map<string, number>();

/** Timestamps of embedding calls started in the last minute, oldest first. */
const recentEmbedCalls: number[] = [];

function pruneWindow(now: number) {
  while (recentEmbedCalls.length && now - recentEmbedCalls[0] >= RATE_WINDOW_MS) {
    recentEmbedCalls.shift();
  }
}

/**
 * Sliding-window gate in front of every embedding call.
 *
 * Warm serverless instances reuse this module, so back-to-back ingests on the
 * same instance share the window. `deadline` stops the gate from parking a
 * request past the function's own time limit — better a clear quota message than
 * a silent platform timeout.
 */
async function reserveEmbedSlot(deadline: number | undefined) {
  for (;;) {
    const now = Date.now();
    pruneWindow(now);

    if (recentEmbedCalls.length < EMBED_RPM_BUDGET) {
      recentEmbedCalls.push(now);
      return;
    }

    const waitMs = RATE_WINDOW_MS - (now - recentEmbedCalls[0]) + 50;
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

export function embedQuery(text: string): Promise<number[]> {
  return withRetry(() => embedOnce(text, 'RETRIEVAL_QUERY')).then(l2Normalise);
}

/**
 * gemini-embedding-001 exposes no synchronous batch endpoint, so this fans out
 * single calls with bounded concurrency behind the rate gate above.
 */
export async function embedDocuments(
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
      await reserveEmbedSlot(deadline);
      const vector = await withRetry(
        () => embedOnce(texts[index], 'RETRIEVAL_DOCUMENT', title),
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
  const { contents, systemInstruction, tools, signal, onText } = options;
  const candidates = options.models?.length ? options.models : CHAT_MODELS;

  let lastError: unknown;
  let quotaHit = false;

  for (const model of candidates) {
    // Skip a model known to be rate-limited — but only when there is somewhere
    // else to go. If the visitor pinned one model, try it and report the truth
    // rather than refusing on the strength of a stale timestamp.
    const cooldown = exhaustedUntil.get(model);
    if (candidates.length > 1 && cooldown && cooldown > Date.now()) {
      quotaHit = true;
      continue;
    }

    let response: Response;
    try {
      response = await fetch(
        `${API_ROOT}/${model}:streamGenerateContent?alt=sse&key=${env.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal,
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
      if (signal?.aborted) throw error;
      lastError = error;
      continue;
    }

    if (!response.ok || !response.body) {
      const body = await response.text();
      if (response.status === 429) {
        quotaHit = true;
        exhaustedUntil.set(model, Date.now() + (retryDelayMs(body) ?? 60_000));
      }
      lastError = new Error(`${model} responded ${response.status}: ${body.slice(0, 200)}`);
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    }

    // The last frame often arrives without a trailing newline, which would leave
    // it stranded in the buffer and silently truncate the answer mid-sentence.
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer.trim());

    exhaustedUntil.delete(model);

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
