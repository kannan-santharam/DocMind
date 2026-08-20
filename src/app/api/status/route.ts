import { NextResponse } from 'next/server';
import { isConfigured } from '@/lib/env';
import { isTracingEnabled } from '@/lib/tracing';

export const runtime = 'nodejs';
// Never cached: this reports the live configuration of the running instance, and a
// cached answer would describe a build that is no longer serving.
export const dynamic = 'force-dynamic';

/** Present or absent only. Never the value — this endpoint is public. */
function present(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

/**
 * Lets the UI show a real setup message instead of a generic 500, and lets a
 * deploy be diagnosed with one request.
 *
 * "tracing: false" on its own is not actionable — it could be a missing variable,
 * one set on the wrong environment, a typo in the name, or a deployment that
 * predates the change. Reporting which names the running instance can actually
 * see turns that into a single answer. Names and booleans only; no values.
 */
export function GET() {
  const optional = {
    LANGFUSE_PUBLIC_KEY: present('LANGFUSE_PUBLIC_KEY'),
    LANGFUSE_SECRET_KEY: present('LANGFUSE_SECRET_KEY'),
    LANGFUSE_BASE_URL: present('LANGFUSE_BASE_URL'),
    TRUSTED_ORIGINS: present('TRUSTED_ORIGINS'),
    SEED_TOKEN: present('SEED_TOKEN'),
    RATE_LIMIT_SALT: present('RATE_LIMIT_SALT'),
  };

  return NextResponse.json({
    configured: isConfigured(),
    tracing: isTracingEnabled(),
    missing: [
      !present('GEMINI_API_KEY') && 'GEMINI_API_KEY',
      !present('SUPABASE_URL') && 'SUPABASE_URL',
      !present('SUPABASE_SERVICE_ROLE_KEY') && 'SUPABASE_SERVICE_ROLE_KEY',
    ].filter(Boolean),
    optional,
    // Distinguishes "the variable is not set" from "this build predates it".
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
  });
}
