import { NextResponse, type NextRequest } from 'next/server';
import { readableSessions, requireSessionId, SEED_SESSION_ID, SessionError } from '@/lib/session';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const sessionId = requireSessionId(req);
    const { data, error } = await supabase()
      .from('documents')
      .select(
        'id, filename, mime, source_kind, page_count, char_count, chunk_count, outline, created_at, session_id',
      )
      .in('session_id', readableSessions(sessionId))
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Preloaded documents sort last so the visitor's own uploads stay on top.
    const documents = (data ?? [])
      .map(({ session_id, ...doc }) => ({ ...doc, is_public: session_id === SEED_SESSION_ID }))
      .sort((first, second) => Number(first.is_public) - Number(second.is_public));

    return NextResponse.json({ documents });
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
