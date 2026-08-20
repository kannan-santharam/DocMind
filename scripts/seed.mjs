#!/usr/bin/env node
/**
 * Load the preloaded document every visitor can see.
 *
 *   pnpm dev                      # in one terminal
 *   node scripts/seed.mjs         # in another
 *   node scripts/seed.mjs https://your-app.vercel.app
 *
 * Ingestion goes through /api/ingest rather than reimplementing parse, chunk and
 * embed here, so the seeded document travels the exact pipeline a visitor's
 * upload does. Everything else — purging the previous version, clearing the
 * rate-limit counters this script would otherwise trip — goes straight to
 * PostgREST with the service-role key.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_SESSION_ID = '00000000-0000-4000-8000-000000000001';

/** The architecture write-up, always seeded, retitled for the sidebar. */
const ARCHITECTURE = {
  path: fileURLToPath(new URL('../docs/ARCHITECTURE.md', import.meta.url)),
  title: 'How DocMind Works — Architecture & Decisions.md',
};

/** Anything dropped in docs/seed is preloaded too — resume, bio, project notes. */
const SEED_DIR = fileURLToPath(new URL('../docs/seed/', import.meta.url));

const SUPPORTED = new Set(['.pdf', '.docx', '.txt', '.md', '.markdown']);
const MIME = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
};

const baseUrl = (process.argv[2] ?? 'http://localhost:3000').replace(/\/+$/, '');

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
      /* optional */
    }
  }
}

await loadEnv();

const supabaseUrl = (process.env.SUPABASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '')
  .replace(/\/rest\/v1$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. See .env.example.');
  process.exit(1);
}

const seedToken = process.env.SEED_TOKEN;
if (!seedToken) {
  console.error(
    'SEED_TOKEN must be set. Writes to the shared namespace are rejected without it —\n' +
      'its id is a public constant, so anything else would let a stranger inject documents.',
  );
  process.exit(1);
}

const dbHeaders = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
};

async function purge() {
  // Chunks cascade from documents.
  const documents = await fetch(
    `${supabaseUrl}/rest/v1/documents?session_id=eq.${SEED_SESSION_ID}`,
    { method: 'DELETE', headers: { ...dbHeaders, Prefer: 'return=representation' } },
  );
  const removed = documents.ok ? (await documents.json()).length : 0;

  // Re-seeding more than ten times an hour would otherwise trip the ingest limit.
  await fetch(`${supabaseUrl}/rest/v1/rate_limits?session_id=eq.${SEED_SESSION_ID}`, {
    method: 'DELETE',
    headers: dbHeaders,
  });

  return removed;
}

async function collect() {
  const files = [ARCHITECTURE];

  let entries = [];
  try {
    entries = await readdir(SEED_DIR);
  } catch {
    return files; // folder is optional
  }

  for (const entry of entries.sort()) {
    if (entry === 'README.md' || entry.startsWith('.')) continue;
    if (!SUPPORTED.has(extname(entry).toLowerCase())) continue;
    files.push({ path: SEED_DIR + entry, title: basename(entry) });
  }
  return files;
}

const files = await collect();
console.log(`\nSeeding ${files.length} document(s) → ${baseUrl}`);

const removed = await purge();
if (removed) console.log(`  removed ${removed} previous version(s)\n`);

let failed = 0;
let passages = 0;

for (const file of files) {
  const bytes = await readFile(file.path);
  const form = new FormData();
  form.append(
    'file',
    new File([bytes], file.title, {
      type: MIME[extname(file.title).toLowerCase()] ?? 'application/octet-stream',
    }),
  );

  const response = await fetch(`${baseUrl}/api/ingest`, {
    method: 'POST',
    headers: { 'x-session-id': SEED_SESSION_ID, 'x-seed-token': seedToken },
    body: form,
  });
  const payload = await response.json().catch(() => ({}));

  const name = file.title.replace(/\.(md|markdown)$/, '');
  if (!response.ok) {
    failed++;
    console.error(`  ✗ ${name} — ${payload.error ?? `HTTP ${response.status}`}`);
    continue;
  }

  passages += payload.document.chunk_count;
  console.log(`  ✓ ${name} — ${payload.document.chunk_count} passages`);
  for (const note of payload.notes ?? []) console.log(`      note: ${note}`);
}

console.log(
  failed
    ? `\n${passages} passages seeded, ${failed} document(s) failed.\n`
    : `\n✓ ${passages} passages shared with every visitor.\n`,
);
process.exit(failed ? 1 : 0);
