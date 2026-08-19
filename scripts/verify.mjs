#!/usr/bin/env node
/**
 * Preflight check. Run after filling in .env.local and applying supabase/schema.sql:
 *
 *   node scripts/verify.mjs
 *
 * Confirms the Gemini key works, the embedding dimension matches the schema, and
 * every table and RPC the app calls actually exists — so a broken deploy fails
 * here rather than in front of a recruiter.
 */

import { readFile } from 'node:fs/promises';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let failures = 0;

function pass(label, detail = '') {
  console.log(`${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}

function fail(label, detail = '') {
  failures++;
  console.log(`${RED}✗${RESET} ${label}${detail ? `\n  ${DIM}${detail}${RESET}` : ''}`);
}

async function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    try {
      const raw = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const line of raw.split('\n')) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (match && !process.env[match[1]]) {
          process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      /* file is optional */
    }
  }
}

const EMBED_DIM = 768;
const EMBED_MODEL = 'gemini-embedding-001';

async function checkGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fail('GEMINI_API_KEY', 'not set — see .env.example');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${EMBED_MODEL}`,
        content: { parts: [{ text: 'preflight' }] },
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: EMBED_DIM,
      }),
    },
  );

  if (!response.ok) {
    return fail('Gemini embeddings', `${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  const { embedding } = await response.json();
  if (embedding?.values?.length !== EMBED_DIM) {
    return fail(
      'Embedding dimension',
      `expected ${EMBED_DIM}, got ${embedding?.values?.length}. The chunks.embedding column must match.`,
    );
  }
  pass('Gemini embeddings', `${EMBED_MODEL} @ ${EMBED_DIM}d`);
}

/** Mirrors the app's cascade: any working model means chat is fine. */
const CHAT_MODELS = [
  'gemini-flash-latest',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
];

async function checkGeminiChat() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return;

  const exhausted = [];

  for (const model of CHAT_MODELS) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ready' }] }],
          generationConfig: { maxOutputTokens: 16 },
        }),
      },
    );

    if (response.ok) {
      const note = exhausted.length
        ? `${model} — ${exhausted.length} ahead of it out of quota (${exhausted.join(', ')})`
        : model;
      return pass('Gemini chat', note);
    }
    if (response.status === 429) exhausted.push(model);
    else
      return fail('Gemini chat', `${model} ${response.status}: ${(await response.text()).slice(0, 160)}`);
  }

  fail(
    'Gemini chat',
    `all ${CHAT_MODELS.length} models are out of free-tier quota right now — they reset daily`,
  );
}

function supabaseOrigin() {
  return (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}

async function supabaseRequest(path, init = {}) {
  const url = supabaseOrigin();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return fetch(`${url}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}

async function checkSupabase() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return fail('Supabase credentials', 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }

  for (const table of ['documents', 'chunks', 'rate_limits']) {
    const response = await supabaseRequest(`/${table}?select=*&limit=1`);
    if (response.ok) pass(`Table ${table}`);
    else fail(`Table ${table}`, `${response.status}: ${(await response.text()).slice(0, 160)}`);
  }

  const zeroVector = new Array(EMBED_DIM).fill(0);
  const match = await supabaseRequest('/rpc/match_chunks', {
    method: 'POST',
    body: JSON.stringify({
      query_embedding: zeroVector,
      p_session_id: '00000000-0000-4000-8000-000000000000',
      match_count: 1,
    }),
  });
  if (match.ok) pass('RPC match_chunks');
  else fail('RPC match_chunks', `${match.status}: ${(await match.text()).slice(0, 200)}`);

  const bump = await supabaseRequest('/rpc/bump_rate_limit', {
    method: 'POST',
    body: JSON.stringify({
      p_session_id: '00000000-0000-4000-8000-000000000000',
      p_bucket: 'preflight',
      p_window_secs: 60,
      p_limit: 1000,
    }),
  });
  if (bump.ok) pass('RPC bump_rate_limit');
  else fail('RPC bump_rate_limit', `${bump.status}: ${(await bump.text()).slice(0, 200)}`);
}

async function checkLangfuse() {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;

  if (!publicKey || !secretKey) {
    console.log(`${DIM}○${RESET} Langfuse tracing ${DIM}not configured — optional, tracing is a no-op${RESET}`);
    return;
  }

  const base = (process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com').replace(/\/+$/, '');
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');

  try {
    const response = await fetch(`${base}/api/public/health`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (response.ok) pass('Langfuse tracing', `${base} — traces named "DocMind"`);
    else fail('Langfuse tracing', `${response.status}: ${(await response.text()).slice(0, 160)}`);
  } catch (error) {
    fail('Langfuse tracing', String(error).slice(0, 160));
  }
}

await loadEnv();
console.log('\nDocMind preflight\n');
await checkGemini();
await checkGeminiChat();
await checkSupabase();
await checkLangfuse();

console.log(
  failures === 0
    ? `\n${GREEN}All checks passed.${RESET} Run \`pnpm dev\`.\n`
    : `\n${RED}${failures} check(s) failed.${RESET} Fix the above, then re-run.\n`,
);
process.exit(failures === 0 ? 0 : 1);
