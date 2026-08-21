import { NextResponse, type NextRequest } from 'next/server';
import { isTrustedOrigin } from '@/lib/privacy';
import { excludedRegionDocument, resolveRegion } from '@/lib/region';
import {
  canWriteSharedNamespace,
  readableSessions,
  requireSessionId,
  SEED_SESSION_ID,
  SessionError,
} from '@/lib/session';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const sessionId = requireSessionId(req);
    const trusted = isTrustedOrigin(req);
    const region = resolveRegion(req);

    const { data, error } = await supabase()
      .from('documents')
      .select(
        'id, filename, mime, source_kind, page_count, char_count, chunk_count, outline, created_at, session_id',
      )
      .in('session_id', readableSessions(sessionId, trusted))
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // The other region's availability edition is hidden from the sidebar for the
    // same reason it is hidden from retrieval — a visitor in Chennai should not
    // see a document called "Dubai Relocation and Availability" listed as part of
    // Kannan's profile. Scoped to the preloaded namespace so a visitor's own
    // upload is never hidden from them.
    const excluded = excludedRegionDocument(region);

    // Preloaded documents sort last so the visitor's own uploads stay on top.
    const documents = (data ?? [])
      .map(({ session_id, ...doc }) => ({ ...doc, is_public: session_id === SEED_SESSION_ID }))
      .filter((doc) => !(doc.is_public && doc.filename === excluded))
      .sort((first, second) => Number(first.is_public) - Number(second.is_public));

    return NextResponse.json({ documents, trusted, region });
  } catch (error) {
    if (error instanceof SessionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Could not load documents.' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const sessionId = requireSessionId(req);

    if (sessionId === SEED_SESSION_ID && !canWriteSharedNamespace(req)) {
      return NextResponse.json(
        { error: 'Not authorised to modify the shared namespace.' },
        { status: 403 },
      );
    }

    const id = req.nextUrl.searchParams.get('id');

    // Scoped to the caller's own session, so the preloaded documents are not
    // theirs to delete. Chunks cascade from documents, so one delete is enough.
    const query = supabase().from('documents').delete().eq('session_id', sessionId);
    const { error } = id ? await query.eq('id', id) : await query;

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SessionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Could not delete.' }, { status: 500 });
  }
}
