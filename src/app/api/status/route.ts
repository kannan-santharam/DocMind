import { NextResponse } from 'next/server';
import { isConfigured } from '@/lib/env';
import { isTracingEnabled } from '@/lib/tracing';

export const runtime = 'nodejs';

/** Lets the UI show a real setup message instead of a generic 500. */
export function GET() {
  return NextResponse.json({
    configured: isConfigured(),
    // Drives the disclosure next to the message box. The notice is shown only
    // when questions are genuinely being sent to Langfuse — a privacy notice
    // that is wrong in either direction is worse than none.
    tracing: isTracingEnabled(),
    missing: [
      !process.env.GEMINI_API_KEY && 'GEMINI_API_KEY',
      !process.env.SUPABASE_URL && 'SUPABASE_URL',
      !process.env.SUPABASE_SERVICE_ROLE_KEY && 'SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean),
  });
}
