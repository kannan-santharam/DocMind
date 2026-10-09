import { NextResponse, type NextRequest } from 'next/server';
import { runAgent } from '@/lib/agent';
import { ApiKeyRequiredError, resolveApiKey } from '@/lib/apiKey';
import { QuotaExhaustedError, type GeminiContent } from '@/lib/gemini';
import { resolveModels } from '@/lib/models';
import { checkRateLimit, LIMITS, rateLimitIdentity } from '@/lib/rateLimit';
import { isTrustedOrigin } from '@/lib/privacy';
import { resolveRegion } from '@/lib/region';
import { normaliseSettings } from '@/lib/settings';
import { requireSessionId, SessionError } from '@/lib/session';
import { startTrace } from '@/lib/tracing';
import type { ChatStreamEvent } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Turns kept in context. Older ones are dropped rather than summarised. */
const MAX_HISTORY_TURNS = 12;

interface IncomingMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function POST(req: NextRequest) {
  let sessionId: string;
  try {
    sessionId = requireSessionId(req);
  } catch (error) {
    const message = error instanceof SessionError ? error.message : 'Bad request.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as {
    messages?: IncomingMessage[];
    settings?: unknown;
  } | null;
  const messages = body?.messages ?? [];

  // Re-clamped server-side. The browser clamps too, but the browser is not the
  // authority — an unbounded maxTurns would let one visitor spend the whole
  // day's model quota in a handful of requests, and an unvetted model id gets
  // interpolated straight into the Gemini request URL.
  const settings = normaliseSettings(body?.settings);
  const models = resolveModels(settings.model);

  // Two independent facts about the visitor, both read off the request.
  // Trust gates the preloaded documents and the contact details inside them;
  // region picks which availability edition of the profile is in scope.
  const trusted = isTrustedOrigin(req);
  const region = resolveRegion(req);

  // Whose quota answers this. Through the portfolio it is Kannan's key; at the
  // public URL the visitor supplies their own, because one free-tier key cannot
  // absorb an unbounded audience. A missing key is not an error to display raw —
  // `needsKey` is what makes the client show the setup panel instead.
  let credential;
  try {
    credential = resolveApiKey(req);
  } catch (error) {
    if (error instanceof ApiKeyRequiredError) {
      return NextResponse.json({ error: error.message, needsKey: true }, { status: 401 });
    }
    throw error;
  }

  if (!messages.length || messages[messages.length - 1]?.role !== 'user') {
    return NextResponse.json(
      { error: 'The last message must come from the user.' },
      { status: 400 },
    );
  }

  const limit = await checkRateLimit(
    rateLimitIdentity(req, sessionId),
    'chat',
    LIMITS.chat.windowSecs,
    LIMITS.chat.max,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      {
        // Deliberately not phrased as a Gemini quota. On a visitor's own key this
        // is purely this demo's own request cap, and blaming the free tier would
        // send them looking at the wrong dashboard.
        error:
          credential.source === 'visitor'
            ? `Message limit reached (${LIMITS.chat.max} per 10 minutes). That is this demo's own cap on requests it will serve, not a limit on your Gemini key — it resets at ${limit.resetsAt}.`
            : `Message limit reached (${LIMITS.chat.max} per 10 minutes). This is a public demo running on a free Gemini tier — it resets at ${limit.resetsAt}.`,
      },
      { status: 429 },
    );
  }

  // Trim to a user boundary: the client always sends an odd number of messages,
  // so a fixed-size tail can start on an assistant turn — an answer with its
  // question sliced off, which is noise in the context at best.
  const recent = messages.slice(-MAX_HISTORY_TURNS).filter((m) => m.content.trim());
  while (recent.length && recent[0].role !== 'user') recent.shift();

  const history: GeminiContent[] = recent.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  }));

  const encoder = new TextEncoder();
  const abort = new AbortController();
  // The browser navigating away should stop the Gemini calls, not just the writes.
  req.signal.addEventListener('abort', () => abort.abort());

  const question = messages[messages.length - 1].content;

  const trace = startTrace({
    name: 'chat',
    // Grouped by session, so Langfuse shows a whole conversation rather than a
    // pile of unrelated questions — how someone explored a document is the view
    // worth having.
    sessionId,
    input: question,
    metadata: {
      model: settings.model,
      topK: settings.topK,
      threshold: settings.threshold,
      maxTurns: settings.maxTurns,
      historyTurns: history.length,
      origin: trusted ? 'portfolio' : 'direct',
      // Whose quota served the answer. The key itself is never traced.
      keySource: credential.source,
      // On the trace so it is possible to confirm the geo header actually
      // arrives in production, which is otherwise untestable from here.
      region,
    },
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (event: ChatStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        await runAgent({
          sessionId,
          history,
          emit,
          signal: abort.signal,
          settings,
          models,
          trace,
          trusted,
          region,
          credential,
        });
        emit({ type: 'done' });
      } catch (error) {
        if (!abort.signal.aborted) {
          const message =
            error instanceof Error ? error.message : 'The agent hit an unexpected error.';
          trace.update({ metadata: { error: message } });

          // The trace gets the real message; the stream does not. Errors reaching
          // here are raised by Postgres, undici or the Gemini client rather than by
          // this app, and they describe the request that failed — table and column
          // names, header contents, file paths. The two audiences want different
          // things: the log wants detail, the visitor wants to know whether to
          // retry. Errors this app raises deliberately, like a needed key or an
          // exhausted quota, are answered further up and keep their own wording.
          // A spent quota is raised by this app on purpose and its wording is
          // written for visitors, so it goes through as is. Everything else
          // stays generic.
          if (error instanceof QuotaExhaustedError) {
            emit({ type: 'error', message: error.message });
          } else {
            console.error('chat:unhandled', error);
            emit({
              type: 'error',
              message: 'Something went wrong answering that. Try asking again.',
            });
          }
        }
      } finally {
        // Flush before the stream closes. A serverless function freezes the
        // instant its response finishes, so anything still sitting in the
        // Langfuse queue at that point is lost — this await is the whole
        // difference between tracing that works in production and tracing that
        // works only on a long-lived dev server.
        await trace.flush();

        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by the client disconnecting */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Vercel's edge proxy buffers responses without this.
      'X-Accel-Buffering': 'no',
    },
  });
}
