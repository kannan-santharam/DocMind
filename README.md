# DocMind — Agentic RAG over your documents

Upload a PDF, DOCX, Markdown file or paste text, then ask questions about it. A
tool-calling Gemini agent decides **when** to retrieve, rewrites its own query when
results come back thin, and cites the exact passage behind every claim.

Built by [Kannan Appiya Santharam](https://linkedin.com/in/askannan)

![Next.js](https://img.shields.io/badge/Next.js-16-000?logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![Gemini](https://img.shields.io/badge/Gemini-function%20calling-0052FF?logo=googlegemini&logoColor=white)
![pgvector](https://img.shields.io/badge/Supabase-pgvector-3ECF8E?logo=supabase&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** is the long-form write-up: every design
decision, what the free-tier quotas forced to change, and the bugs found along the way.

---

## Why this is not another RAG demo

The usual tutorial pipeline is fixed: embed the question → fetch top-k → stuff the
prompt → answer. It retrieves even when retrieval is pointless ("thanks!"), and it
gets one shot at phrasing the query.

Here the model holds the tools and drives the loop:

| Behaviour | Fixed-pipeline RAG | DocMind |
|---|---|---|
| Retrieval decision | always | model chooses per turn |
| Query phrasing | the user's raw question | model rewrites for the index |
| Weak results | answers anyway | searches again with different terms |
| "What's in this doc?" | vector search, badly | `list_sections` tool |
| Visibility | a spinner | the decision trail, streamed live |

The agent trace above each answer shows the actual calls — query text, passages
returned, top similarity, latency — so the agency is demonstrated rather than claimed.

## Stack

| Layer | Choice | Note |
|---|---|---|
| Framework | Next.js 16 (App Router) | Streaming route handlers, one Vercel deploy |
| Model | `gemini-3.6-flash` | Native function calling; cascades to `gemini-flash-latest` → `gemini-3.1-flash-lite` |
| Embeddings | `gemini-embedding-001` @ 768d | Matryoshka truncation from the 3072 default |
| Vector store | Supabase Postgres + pgvector | HNSW, cosine distance |
| Parsing | `unpdf`, `mammoth` | Both serverless-safe |
| Tracing | Langfuse | Optional. One trace per question, generation per agent turn, span per retrieval |
| UI | React 19, Tailwind CSS v4, lucide-react | Shares the portfolio's design tokens |

### Four decisions worth explaining

**768 dimensions, not 3072.** `gemini-embedding-001` returns 3072 by default, but
pgvector's HNSW index rejects anything above 2000. It is a Matryoshka model, so a
768-dim prefix is a valid embedding — re-normalised to unit length after truncation,
since a sliced vector is no longer normalised and cosine distance would skew.

**`unpdf`, not `pdf-parse`.** `pdf-parse` reads a bundled test PDF at import time,
which throws the moment it is bundled into a serverless function. `unpdf` ships a
pdfjs build compiled for exactly this environment.

**The model cascade is about quota, not quality.** Free-tier limits differ per model
by more than an order of magnitude, and they are the binding constraint on a public
demo. Measured against the live API: `gemini-3-flash-preview` allows **20 requests per
day**, so it is not in the chain despite being the newest; `gemini-2.5-flash` now 404s
for new keys. The lite model sits last because its quota is the most generous — when
everything above is exhausted, a slightly weaker answer beats an error page.

**Session namespacing.** The demo is public and has no accounts. Every row carries a
client-generated session UUID, and `match_chunks` filters on it inside the SQL
function rather than trusting each caller to remember — otherwise one visitor's
upload answers another visitor's question.

## Architecture

```
                    ┌──────────────── browser ────────────────┐
                    │  upload zone · chat · agent trace · SSE  │
                    └────────────────────┬────────────────────┘
                                         │  x-session-id
        ┌────────────────────────────────┴────────────────────────────┐
        │                                                             │
  POST /api/ingest                                            POST /api/chat
        │                                                             │
  parse (unpdf / mammoth / text)                          ┌── agent loop (≤5 turns)
        │                                                 │
  chunk — heading-aware, ~1100 chars, 180 overlap         │   model emits tool call?
        │                                                 │      │
  embed — 768d, RETRIEVAL_DOCUMENT, 5 at a time           │      ├─ search_document
        │                                                 │      │    embed query (768d)
        ▼                                                 │      │    match_chunks RPC
  ┌───────────────────────────────┐                       │      │    → numbered passages
  │  Supabase Postgres            │◄──────────────────────┤      │
  │  documents · chunks (hnsw)    │                       │      └─ list_sections
  │  match_chunks · bump_rate_…   │                       │
  └───────────────────────────────┘                       └── else: stream the answer
                                                              + citations event
```

## Two modes, one deployment

Reached through a **trusted origin** (`TRUSTED_ORIGINS`), the app is a personal
assistant: documents from `docs/seed/` are preloaded and answerable immediately.
Reached at its **own URL** it is a blank document Q&A tool — nothing preloaded, upload
something to begin — because there it is a public endpoint anyone can talk to. The same
check also decides whether contact details inside those documents survive redaction.

Unset `TRUSTED_ORIGINS` means restricted mode everywhere. Fails closed.

## The preloaded documents

Through a trusted origin, visitors arrive with documents already indexed, so the first
thing they can do is ask a question rather than hunt for a file to upload.
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is always seeded — a full write-up of how
this system is built and why — which means you can interrogate the system using the
system.

It lives in a fixed session namespace (`SEED_SESSION_ID`) that every search reads in
addition to the visitor's own. That keeps the feature entirely in application code:
`match_chunks` keeps its exact signature, so no migration and no `create or replace
function` — retrieval just runs once per namespace in parallel and merges by
similarity. Visitors can see it and cannot delete it, because deletes stay scoped to
the caller's own session.

Drop additional files into `docs/seed/` — a resume, a bio, project notes — and they are
preloaded the same way. Filenames become the titles shown in the sidebar, so name them
the way you want them read.

> `docs/seed/` is gitignored apart from its README: those files are personal content, not
> source. A fresh clone seeds only the architecture document, which is the intended
> behaviour — bring your own.

To load or refresh it:

```bash
pnpm dev                    # in one terminal
pnpm seed                   # in another
pnpm seed https://your-app.vercel.app   # or against the deployment
```

Seeding needs `SEED_TOKEN`. The shared namespace's id is a constant in this repo, so
without a secret anyone reading the source could inject documents into it — writes are
rejected unless the token matches, and an unset token disables seeding entirely.

## Running locally

Requires Node 20+ and pnpm 9 or newer.

```bash
pnpm install
cp .env.example .env.local     # fill in the three required values
pnpm verify                    # preflight: keys, embedding dim, tables, RPCs
pnpm dev
```

### 1. Gemini key

Free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → `GEMINI_API_KEY`.

### 2. Supabase

Create a free project, then **SQL Editor → New query** and run
[`supabase/schema.sql`](supabase/schema.sql). It creates the tables, the HNSW index,
`match_chunks`, `bump_rate_limit`, and `purge_expired`.

From **Settings → API**, copy the project URL into `SUPABASE_URL` and the
**service_role** key into `SUPABASE_SERVICE_ROLE_KEY`.

> The service-role key bypasses row-level security. It is read only in server-side
> route handlers and is never exposed to the browser — which is why neither variable
> is `NEXT_PUBLIC_`-prefixed.

### 3. Langfuse (optional)

Leave the keys blank and tracing is a no-op. With them set, every question becomes a
trace named `DocMind`, grouped by session, showing each agent turn with its model and
token counts and each retrieval with its query and top similarity score.

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-…
LANGFUSE_SECRET_KEY=sk-lf-…
LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or your region's host
```

> Traces include the questions visitors ask. On a public demo that is third-party
> logging of user input — worth disclosing in the UI before going live.

## Deploying to Vercel

1. Push to GitHub.
2. Import the repo at [vercel.com/new](https://vercel.com/new) — the Next.js preset needs no changes.
3. Add `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` under **Settings → Environment Variables**.
4. Deploy.

Optional: schedule `select purge_expired();` in **Supabase → Database → Cron** to drop
anonymous uploads older than 24 hours.

## Limits, and why they exist

| Limit | Value | Reason |
|---|---|---|
| Upload size | 4 MB | Vercel caps a serverless request body at ~4.5 MB |
| Passages per document | 80 | Gemini's free tier allows 100 embed calls/minute and one call embeds one passage — measured, not assumed: 220 calls at concurrency 5 threw a 429 on request 99 |
| Messages | 25 / 10 min / session | A public demo on a free Gemini tier is drainable |
| Uploads | 10 / hour / session | Same |
| Agent turns | 5 per answer | Each turn is a round trip against a per-day model quota |

The embedding client paces itself with a sliding-window gate at 85 requests/minute so
a normal upload never triggers the quota at all, and honours the `retryDelay` Gemini
returns rather than guessing at a backoff.

**Scanned PDFs are rejected.** Extraction needs a text layer; OCR is out of scope and
the error says so rather than silently indexing an empty document.

**The session id is not an authorisation boundary.** It is an unguessable v4 UUID in
`localStorage`, which is enough to isolate one anonymous visitor's documents from
another's. Real accounts would mean Supabase Auth plus RLS policies keyed on `auth.uid()`.

## Project layout

```
src/
  app/
    api/chat/route.ts        SSE stream; owns rate limiting and history trimming
    api/ingest/route.ts      parse → chunk → embed → insert, with rollback
    api/documents/route.ts   list / delete (chunks cascade)
    api/status/route.ts      config check, so a missing key shows a message not a 500
  lib/
    agent.ts                 the tool-calling loop and its two tools
    gemini.ts                embeddings + streamed generation, model cascade, retries
    chunk.ts                 heading-aware chunking with overlap
    parse.ts                 PDF / DOCX / TXT / MD / pasted text
    rateLimit.ts             Postgres-backed fixed window
  components/                chat UI: trace, citations, streaming markdown
docs/ARCHITECTURE.md         the preloaded document: how and why this is built
supabase/schema.sql          tables, HNSW index, RPCs
scripts/verify.mjs           preflight checks
scripts/seed.mjs             load the preloaded document
```

## What this is not

Stated plainly, because a demo that overpromises is worse than one with a short feature
list:

- **Not multimodal.** Text only. Charts, diagrams and screenshots inside a PDF are not
  read, and images in a DOCX are indexed by their alt text or not at all.
- **No OCR.** A scanned PDF is rejected with an explanation rather than indexed empty.
- **Not authenticated.** Session isolation keeps one anonymous visitor's uploads out of
  another's answers; it is not an authorisation boundary.
- **Not tuned for hostile corpora.** Dense vector search only — no BM25, no hybrid
  fusion, no reranking. Those are the obvious next steps, not things already done.

## License

MIT
