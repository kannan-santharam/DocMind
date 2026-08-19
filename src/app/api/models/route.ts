import { NextResponse } from 'next/server';
import { MODELS } from '@/lib/models';

export const runtime = 'nodejs';

/**
 * The model picker's options.
 *
 * Deliberately static. Live "is this model rate-limited right now" state cannot
 * be served honestly from here: this route and /api/chat are separate serverless
 * functions with separate process memory, so any in-memory exhaustion map read
 * here would be stale relative to whichever instance last served a chat. A wrong
 * "available" badge is worse than no badge — the quota note is the useful
 * information anyway.
 */
export function GET() {
  return NextResponse.json({ models: MODELS });
}
