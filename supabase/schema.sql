-- =============================================================================
-- DocMind — Supabase schema
-- Run once in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- =============================================================================

create extension if not exists vector;

-- -----------------------------------------------------------------------------
-- documents: one row per uploaded file or pasted text blob
-- -----------------------------------------------------------------------------
create table if not exists documents (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null,
  filename     text not null,
  mime         text not null,
  source_kind  text not null check (source_kind in ('pdf', 'docx', 'text', 'markdown', 'paste')),
  page_count   int,
  char_count   int not null default 0,
  chunk_count  int not null default 0,
  outline      jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists documents_session_idx on documents (session_id, created_at desc);

-- -----------------------------------------------------------------------------
-- chunks: embedded slices of a document
--
-- 768 dims, not the model default of 3072: gemini-embedding-001 is a Matryoshka
-- model (truncating the vector and re-normalising is lossy but supported), and
-- pgvector's HNSW index refuses anything above 2000 dimensions.
-- -----------------------------------------------------------------------------
create table if not exists chunks (
  id           bigserial primary key,
  document_id  uuid not null references documents(id) on delete cascade,
  session_id   uuid not null,
  ordinal      int not null,
  heading      text,
  page_from    int,
  page_to      int,
  content      text not null,
  token_est    int not null default 0,
  embedding    vector(768) not null
);

create index if not exists chunks_session_idx  on chunks (session_id);
create index if not exists chunks_document_idx on chunks (document_id, ordinal);

-- Cosine HNSW. m/ef_construction are the pgvector defaults; fine at demo scale.
create index if not exists chunks_embedding_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- match_chunks: cosine similarity search, always scoped to one session.
--
-- The session filter is inside the function rather than left to the caller so a
-- forgotten `.eq('session_id', ...)` cannot leak one visitor's upload into
-- another visitor's answers.
-- -----------------------------------------------------------------------------
create or replace function match_chunks (
  query_embedding vector(768),
  p_session_id    uuid,
  match_count     int   default 6,
  min_similarity  float default 0.0,
  p_document_id   uuid  default null
)
returns table (
  id          bigint,
  document_id uuid,
  filename    text,
  ordinal     int,
  heading     text,
  page_from   int,
  page_to     int,
  content     text,
  similarity  float
)
language sql stable
as $$
  select
    c.id,
    c.document_id,
    d.filename,
    c.ordinal,
    c.heading,
    c.page_from,
    c.page_to,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where c.session_id = p_session_id
    and (p_document_id is null or c.document_id = p_document_id)
    and 1 - (c.embedding <=> query_embedding) >= min_similarity
  order by c.embedding <=> query_embedding
  limit least(match_count, 20);
$$;

-- -----------------------------------------------------------------------------
-- rate_limits: fixed-window counter, keyed by session.
--
-- The demo is public and unauthenticated; without this one visitor can drain the
-- project's free Gemini quota for everybody.
-- -----------------------------------------------------------------------------
create table if not exists rate_limits (
  session_id   uuid not null,
  bucket       text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (session_id, bucket, window_start)
);

create or replace function bump_rate_limit (
  p_session_id  uuid,
  p_bucket      text,
  p_window_secs int,
  p_limit       int
)
returns table (allowed boolean, remaining int, resets_at timestamptz)
language plpgsql
as $$
declare
  w_start timestamptz;
  new_count int;
begin
  w_start := to_timestamp(floor(extract(epoch from now()) / p_window_secs) * p_window_secs);

  insert into rate_limits (session_id, bucket, window_start, count)
  values (p_session_id, p_bucket, w_start, 1)
  on conflict (session_id, bucket, window_start)
    do update set count = rate_limits.count + 1
  returning rate_limits.count into new_count;

  return query select
    new_count <= p_limit,
    greatest(p_limit - new_count, 0),
    w_start + make_interval(secs => p_window_secs);
end;
$$;

-- -----------------------------------------------------------------------------
-- purge_expired: anonymous demo data is disposable. Call from a Supabase cron
-- job (Database -> Cron) or the /api/documents DELETE path.
-- -----------------------------------------------------------------------------
create or replace function purge_expired (older_than interval default interval '24 hours')
returns int
language plpgsql
as $$
declare
  removed int;
begin
  with gone as (
    delete from documents where created_at < now() - older_than returning 1
  )
  select count(*) into removed from gone;

  delete from rate_limits where window_start < now() - interval '1 day';
  return removed;
end;
$$;

-- -----------------------------------------------------------------------------
-- RLS: the app talks to Postgres exclusively through the service-role key from
-- server-side route handlers, and the browser never holds a Supabase key. RLS is
-- enabled with no permissive policy so that an accidentally-leaked anon key
-- still reads nothing.
-- -----------------------------------------------------------------------------
alter table documents   enable row level security;
alter table chunks      enable row level security;
alter table rate_limits enable row level security;
