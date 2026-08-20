import { NextResponse, type NextRequest } from 'next/server';
import { chunkDocument } from '@/lib/chunk';
import { embedDocuments, QuotaExhaustedError } from '@/lib/gemini';
import { MAX_UPLOAD_BYTES, ParseError, parsePastedText, parseUpload } from '@/lib/parse';
import { checkRateLimit, LIMITS, rateLimitIdentity } from '@/lib/rateLimit';
import {
  canWriteSharedNamespace,
  requireSessionId,
  SEED_SESSION_ID,
  SessionError,
} from '@/lib/session';
import { supabase, toVectorLiteral } from '@/lib/supabase';
import { startTrace } from '@/lib/tracing';

export const runtime = 'nodejs';
/**
 * Parsing + embedding a full document is the slowest path in the app. 60s is the
 * Vercel Hobby ceiling; the 4MB body cap and the chunk cap below keep real
 * uploads comfortably inside it.
 */
export const maxDuration = 60;

/**
 * Sized against the free-tier embedding quota, not the clock.
 *
 * Gemini allows 100 embedContent requests per minute (measured, not assumed) and
 * one request embeds one chunk. 80 leaves headroom inside a single minute, so a
 * normal upload never has to park and wait out a quota window it cannot afford.
 */
const MAX_CHUNKS = 80;

/**
 * Ceiling on extracted text, checked before chunking.
 *
 * The 4MB upload limit bounds *compressed* input: DOCX is a zip and PDF content
 * streams are Flate-compressed, so repetitive content at high compression ratios
 * can expand to orders of magnitude more text. Without this, all of it would be
 * chunked, and only then rejected by MAX_CHUNKS — doing the expensive work first
 * and throwing it away.
 *
 * 80 passages of ~1100 characters is roughly 88,000, so this leaves headroom for
 * a document that legitimately lands near the passage cap while stopping runaway
 * input early. It does not bound peak memory inside the parsers themselves,
 * which materialise their own output; bounding that would need streaming parsers.
 */
const MAX_TEXT_CHARS = 150_000;

/** Leave a margin under maxDuration so a quota wait fails loudly, not by timeout. */
const DEADLINE_MS = 50_000;

export async function POST(req: NextRequest) {
  const deadline = Date.now() + DEADLINE_MS;
  const trace = startTrace({ name: 'ingest' });

  try {
    const sessionId = requireSessionId(req);

    if (sessionId === SEED_SESSION_ID && !canWriteSharedNamespace(req)) {
      return NextResponse.json(
        { error: 'Not authorised to write to the shared namespace.' },
        { status: 403 },
      );
    }

    const limit = await checkRateLimit(
      rateLimitIdentity(req, sessionId),
      'ingest',
      LIMITS.ingest.windowSecs,
      LIMITS.ingest.max,
    );
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Upload limit reached (${LIMITS.ingest.max}/hour). Try again after ${limit.resetsAt}.` },
        { status: 429 },
      );
    }

    const contentType = req.headers.get('content-type') ?? '';
    let filename: string;
    let mime: string;
    let parsed: Awaited<ReturnType<typeof parseUpload>>;

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof File)) {
        return NextResponse.json({ error: 'No file was attached.' }, { status: 400 });
      }
      filename = file.name;
      mime = file.type || 'application/octet-stream';
      parsed = await parseUpload(file);
    } else {
      const body = (await req.json()) as { text?: string; title?: string };
      parsed = parsePastedText(body.text ?? '');
      filename = (body.title ?? '').trim() || 'Pasted text';
      mime = 'text/plain';
    }

    if (parsed.text.length > MAX_TEXT_CHARS) {
      return NextResponse.json(
        {
          error: `That file expands to ${Math.round(parsed.text.length / 1000)}k characters of text; this demo indexes up to ${MAX_TEXT_CHARS / 1000}k. Try a shorter document.`,
        },
        { status: 413 },
      );
    }

    const { chunks, outline: detected } = chunkDocument(parsed.text, {
      hasPages: parsed.sourceKind === 'pdf',
    });

    trace.update({
      output: { filename, chunks: chunks.length },
      metadata: {
        sourceKind: parsed.sourceKind,
        pages: parsed.pageCount,
        chars: parsed.text.length,
        chunks: chunks.length,
        parserNotes: parsed.notes.length,
      },
    });

    // Parser warnings ride in the outline rather than a new column: `outline` is
    // what `list_sections` returns, so this is exactly where the agent needs to
    // see them to tell a user which parts of their document it cannot read.
    const outline = [
      ...parsed.notes.map((note, index) => ({
        heading: `Not indexed — ${note}`,
        ordinal: index,
        page: null,
      })),
      ...detected,
    ];

    if (!chunks.length) {
      return NextResponse.json(
        { error: 'Nothing indexable was found in that document.' },
        { status: 422 },
      );
    }
    if (chunks.length > MAX_CHUNKS) {
      return NextResponse.json(
        {
          error: `That document splits into ${chunks.length} passages; this demo indexes up to ${MAX_CHUNKS}, which is what Gemini's free embedding tier allows inside one request. Try a shorter document.`,
        },
        { status: 413 },
      );
    }

    const db = supabase();

    const { data: doc, error: docError } = await db
      .from('documents')
      .insert({
        session_id: sessionId,
        filename,
        mime,
        source_kind: parsed.sourceKind,
        page_count: parsed.pageCount,
        char_count: parsed.text.length,
        chunk_count: chunks.length,
        outline,
      })
      .select('id, filename, source_kind, page_count, char_count, chunk_count, outline, created_at')
      .single();

    if (docError || !doc) {
      return NextResponse.json(
        { error: `Could not create the document record: ${docError?.message}` },
        { status: 500 },
      );
    }

    try {
      const embedding = trace.span({
        name: 'embed-passages',
        input: { passages: chunks.length, dimensions: 768 },
      });

      const vectors = await embedDocuments(
        chunks.map((c) => (c.heading ? `${c.heading}\n\n${c.content}` : c.content)),
        { title: filename, deadline },
      );

      embedding.end({ output: { embedded: chunks.length } });

      const rows = chunks.map((chunk, index) => ({
        document_id: doc.id,
        session_id: sessionId,
        ordinal: chunk.ordinal,
        heading: chunk.heading,
        page_from: chunk.pageFrom,
        page_to: chunk.pageTo,
        content: chunk.content,
        token_est: chunk.tokenEst,
        embedding: toVectorLiteral(vectors[index]),
      }));

      // 768 floats per row adds up; insert in batches rather than one large body.
      for (let start = 0; start < rows.length; start += 40) {
        const { error: chunkError } = await db.from('chunks').insert(rows.slice(start, start + 40));
        if (chunkError) throw new Error(chunkError.message);
      }
    } catch (error) {
      // A document row with no vectors would show in the sidebar but answer
      // nothing. Roll it back rather than leave that ghost behind.
      await db.from('documents').delete().eq('id', doc.id);
      throw error;
    }

    await trace.flush();
    return NextResponse.json({ document: doc, notes: parsed.notes });
  } catch (error) {
    if (error instanceof SessionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ParseError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof QuotaExhaustedError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    const message = error instanceof Error ? error.message : 'Ingestion failed.';
    trace.update({ metadata: { error: message } });
    await trace.flush();
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export function GET() {
  return NextResponse.json({ maxUploadBytes: MAX_UPLOAD_BYTES, maxChunks: MAX_CHUNKS });
}
