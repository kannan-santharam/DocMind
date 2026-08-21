# DocMind — Architecture and Engineering Decisions

**Built by Kannan Appiya Santharam.** An agentic RAG system: upload a document, ask
questions, get answers grounded in that document with citations back to the exact
passage. This document explains how it works and why each decision was made.

## What is DocMind in one paragraph?

DocMind is a document question-answering system built on retrieval-augmented
generation. A visitor uploads a PDF, DOCX, Markdown file or pastes text. The system
extracts the text, splits it into passages, converts each passage into a numeric
vector, and stores those vectors in Postgres. When the visitor asks a question, a
Gemini model with tool-calling ability decides whether to search, issues its own
search queries, reads the passages that come back, and writes an answer that cites
them. The whole stack is TypeScript on Next.js, deployed as a single app on Vercel,
running on free tiers of Google Gemini and Supabase.

## What does the system do end to end?

Two flows. **Ingestion:** parse the file to text, split into heading-aware passages of
about 1100 characters, call Gemini's embedding model once per passage to get a
768-dimensional vector, insert passages and vectors into Postgres with pgvector.
**Question answering:** send the conversation plus two tool definitions to Gemini,
stream its response, execute any tool call it makes against the vector index, feed the
results back, and repeat until the model writes prose instead of calling a tool. Every
step is streamed to the browser over Server-Sent Events so the user watches it happen.

## Why TypeScript and not Python?

Python dominates ML tutorials, so it looks like the default. It was the wrong choice
here. Nothing in this system needs the Python ML ecosystem: the embedding model and
the language model are both HTTPS endpoints, and no training, no NumPy and no
tokeniser library runs locally. What the project does need is a good serverless
deployment story and a React front end that matches an existing portfolio site.
Vercel's Python runtime is second-class next to its Node runtime, and choosing Python
would have meant two toolchains, two dependency managers and two deployment targets to
ship one demo. TypeScript gives one language across the browser, the API routes and
the ingestion pipeline, with types shared between them.

## Why is this agentic RAG and not a standard RAG pipeline?

A standard RAG pipeline is fixed: embed the question, fetch the top k passages, paste
them into the prompt, generate an answer. It runs the same way every time. It
retrieves even when retrieval is pointless, such as when the user says "thanks" or
asks "summarise what you just told me". It gets exactly one attempt at phrasing the
search query, and if the user's wording does not match the document's wording, the
retrieval fails and the answer is bad.

In DocMind the model holds the tools and drives the loop. It decides per turn whether
to retrieve at all. It writes its own search query rather than reusing the raw
question. If the first search returns weak matches it can search again with different
terms. That is the difference between calling something agentic and it actually being
agentic: control flow is decided by the model at run time, not hard-coded by me.

## How does the agent decide when to search?

Through the system instruction and the tool definitions. The instruction tells it to
call `search_document` before answering anything that depends on document content, to
search again with rephrased terms when results look thin, and explicitly **not** to
search for conversational turns. The tool descriptions tell it what each tool returns.
The model then makes the call itself on each turn.

This is observable behaviour, not theory. Asked "hello, who are you?" the agent makes
zero tool calls and answers directly. Asked "how much did the Rspack migration improve
build times?" it calls `search_document` with the query "Rspack migration build times
duration" — note it rewrote the question into search terms — and answers from the
passages that come back.

## What tools does the agent have?

Two. `search_document(query, k)` runs a semantic search over every passage in the
visitor's session and returns numbered passages with their similarity scores, source
filename and page number. `list_sections()` returns the uploaded documents with their
detected headings, which answers "what is in this document" without a vector search
that would do it badly.

Both are declared to Gemini as function declarations with JSON Schema parameters. The
model emits a `functionCall` part; my loop executes it and sends back a
`functionResponse` part. Keeping the tool surface at two is deliberate — every extra
tool is another decision the model can get wrong, and more prompt tokens on every turn.

## How does a question become an answer, step by step?

1. The browser POSTs the conversation to `/api/chat` with a session ID header.
2. The route checks a Postgres-backed rate limit, trims history to a user boundary, and
   opens a `ReadableStream` back to the browser.
3. The agent loop sends the conversation plus tool definitions to Gemini and streams
   the response.
4. If the model emits text, each fragment is forwarded to the browser immediately as a
   `text` event.
5. If the model emits a tool call, a `trace` event is sent so the UI can show what the
   agent is doing, the tool runs, and a second `trace` event reports the result count,
   top similarity score and elapsed milliseconds.
6. The tool result is appended to the conversation and the loop runs again, up to five
   turns.
7. When the model answers with prose instead of a tool call, the loop ends and a
   `citations` event carries the passages the answer actually referenced.

## How is a document turned into searchable passages?

Parsing produces plain text with page breaks marked. Chunking walks the text as
paragraph blocks, tracking the current Markdown heading and page number. Blocks
accumulate into a buffer until it reaches the target size, then flush as one passage. A
new heading forces an early flush so two unrelated sections never end up blended into
one passage. Blocks larger than the maximum are split on sentence boundaries so a
passage never ends mid-clause.

## Why chunk at about 1100 characters with 180 characters of overlap?

Chunk size trades precision against context. Small chunks match a query sharply but
arrive without enough surrounding text for the model to reason with. Large chunks carry
context but dilute the embedding, because a single vector has to represent several
unrelated ideas at once and ends up close to nothing in particular. Roughly 1100
characters, around 275 tokens, is a paragraph or two: one coherent idea with enough
supporting detail to answer from.

The 180-character overlap exists because a fact can straddle a boundary. If a sentence
ends one passage and its explanation begins the next, neither passage alone answers the
question. Carrying the tail of each passage into the start of the next means the fact
appears whole on at least one side of every split.

## Why are headings prepended to a passage before embedding?

A passage embedded on its own loses the context of the section it came from. A
paragraph under "Refund policy" that says "requests must be made within 45 days" does
not contain the word refund anywhere, so a query about refunds may not match it.
Prepending the heading to the text before embedding puts that context into the vector.
The stored passage content stays clean, so the heading is not repeated back to the
model or shown twice in the citation.

## Why 768-dimensional embeddings when the model returns 3072?

`gemini-embedding-001` is a **Matryoshka** model: it is trained so that a prefix of the
vector is itself a valid embedding, with information front-loaded by importance. The
first 768 components carry the most signal, the next refine it, and so on. Truncating is
therefore a supported operation rather than a hack, and I verified the behaviour against
the live API rather than trusting documentation — requesting 768, 1536 and 3072
dimensions each returns exactly that many floats.

The choice was made on index limits and cost:

| Option | Bytes per vector | HNSW-indexable |
|---|---|---|
| `vector(3072)` — the model's default | 12,288 | no, the `vector` type caps at 2,000 dims |
| `halfvec(3072)` — half precision | 6,144 | yes, `halfvec` indexes up to 4,000 dims |
| `vector(768)` — what this uses | 3,072 | yes |

**Being precise about that middle row, because it is the honest version of this
decision:** 3072 dimensions *are* indexable, via `halfvec` at half precision. So the
2,000-dimension limit ruled out the naive `vector(3072)` approach, not 3072 itself. The
real reason for 768 is cost — a quarter of the storage of the fp32 original, half of the
halfvec alternative, and distance computation that scales down with it — against a
corpus where the discarded precision has nothing to disambiguate. Measured top matches
sit at 0.6–0.8 with retrieval routing correctly between documents.

Where the trade would go the other way: a large corpus of near-identical documents —
contract versions, regulatory amendments, part catalogues — where the difference between
two passages genuinely *is* a fine shade of meaning. There `halfvec(3072)` at twice the
bytes would likely retrieve better, and the general finding is that more dimensions at
lower precision beats fewer dimensions at higher precision for an equal byte budget.

## Why re-normalise a truncated embedding?

Cosine similarity compares direction, not magnitude, and pgvector's cosine operator
assumes the vectors it is given behave sensibly. A full-length embedding comes back
normalised to unit length. Slicing it to its first 768 components leaves a vector that
is no longer unit length, and the distortion is not uniform across vectors — passages
whose meaning is concentrated in the discarded dimensions shrink more than others. That
skews the ranking. Dividing each truncated vector by its own L2 norm restores unit
length and makes the comparison honest again. It is three lines of code that would have
been very hard to debug as a slow drift in result quality.

## Why Supabase pgvector rather than a dedicated vector database?

Three reasons. First, deployment reality: the app runs on Vercel's serverless
functions, which have an ephemeral filesystem and no long-lived process, so an
in-process store like FAISS or a local Chroma cannot work — the index would vanish
between requests. That rules out the whole category of embedded vector stores and
forces a hosted service.

Second, among hosted options, Postgres with pgvector means the vectors live in the same
database as the metadata. Filtering by session, joining passages to their parent
document, cascading deletes when a document is removed — all of that is ordinary SQL
rather than a second system to keep in sync with the first. A dedicated vector service
would have meant two stores and a consistency problem between them.

Third, honesty about scale: at demo volume no vector database is under pressure. The
interesting engineering is in chunking, retrieval quality and the agent loop, not in
vector search throughput. Choosing the option that keeps the data model simple was the
right trade.

## Why is the session filter inside the SQL function?

`match_chunks` takes the session ID as a parameter and filters on it inside the
function body, rather than leaving the caller to add a `where` clause. This is a
security-by-construction choice. If the filter lived in application code, one forgotten
`.eq('session_id', ...)` at any call site would leak one visitor's uploaded document
into another visitor's answers — a data leak that would look like a retrieval quality
bug and could go unnoticed for a long time. Putting it inside the function means no
call site can omit it.

## How are embeddings written to Postgres?

As pgvector's own text literal, a bracketed comma-separated string like `[0.12,-0.04,
...]`, not as a JavaScript array. The Supabase client serialises a JS number array to a
JSON array, and PostgREST does not reliably cast a JSON array to the `vector` type. The
bracketed string is pgvector's documented input format and casts cleanly both for
inserts and for RPC arguments. Passages are inserted in batches of 40 rather than one
large request, because 768 floats per row adds up quickly in a single HTTP body.

## What did the free-tier quotas force me to change?

This was the most instructive part of the project, because the constraints were not the
ones I expected. I assumed the binding limit on ingestion would be time — Vercel's
60-second function ceiling. It was not. Ingestion of a real document takes about 13
seconds. The binding limit was **requests per minute** on the embedding API.

I measured it rather than guessing. Firing 220 embedding requests at a concurrency of 5
produced a 429 on request 99, and then failed every request behind it. The error body
named the quota exactly: 100 embed requests per minute on the free tier. That single
measurement changed three things in the design.

## How does the app avoid hitting the embedding rate limit?

A sliding-window gate in front of every embedding call, budgeted at 85 requests per
minute to leave headroom under the ceiling of 100. Each call records its timestamp;
when 85 calls sit inside the last 60 seconds, the next one waits for the oldest to
expire. Because a warm serverless instance reuses the module, back-to-back uploads on
the same instance share the window rather than each starting fresh.

Retries honour the delay the API itself reports. Gemini's 429 response includes a
`retryDelay` field saying exactly how long to wait, which is far better information
than exponential backoff invented on the client. The retry also checks a deadline: if
waiting would push past the function's own time limit, it fails immediately with a
clear message about the free-tier quota instead of being killed by the platform with no
explanation.

## Why does a document cap at 80 passages?

Because one passage costs one embedding request, and the free tier allows 100 requests
per minute. Eighty passages fit inside a single minute with headroom, so a normal
upload never has to stall waiting for a quota window it cannot afford. The cap is sized
by the quota, not by the clock — my original 220 was sized by the 60-second function
limit, which turned out to be the wrong constraint entirely. Eighty passages is roughly
a 35-page document.

## Why is gemini-3-flash-preview not the model this app uses?

Because its free tier allows **20 requests per day**. I discovered this the way anyone
would prefer not to: the model started returning 429 mid-testing, and the error detail
named the quota — `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, value 20. Since
one answer costs two to four model calls, that model supports roughly five to ten
questions per day across all visitors. It is a fine choice for a personal chatbot and a
useless one for a public demo.

The same cap turned out to apply to `gemini-3.6-flash`, which I had promoted to primary
after removing the preview — so the fix was not a better model but a better structure:
a fallback chain across several models, each with its own independent daily quota, plus
memory of which ones are currently exhausted.

The lesson generalises: on free tiers, the newest model is often the most restricted,
and quota is a first-class architectural constraint rather than an operational detail
to sort out later.

## What generation parameters does the app set, and why so few?

Only `maxOutputTokens`, at 2048. No temperature, no topP, no topK.

That is deliberate and specific to this model family. Google's Gemini 3 guidance is
explicit: do not lower the temperature from its default of 1.0, because the reasoning
engine is tuned for that value and lowering it can cause looping or degraded
performance on complex tasks. Every model in this app's cascade is a Gemini 3 model.

This runs against the usual instinct. Conventional RAG advice is to set a low
temperature so answers stay factual, and an earlier version of this app used 0.2 for
exactly that reason. That was wrong for these models. Grounding in a RAG system comes
from the retrieved passages and the system instruction, not from suppressing the
sampler — if a model invents facts at temperature 1.0, the fix is better retrieval and
a stricter instruction, not a smaller temperature. `topK` and `topP` are left unset for
the same reason: tuning the sampling distribution of a reasoning model to compensate
for a retrieval problem treats the symptom.

The general principle: read the guidance for the specific model you are calling rather
than carrying parameter habits across model generations.

## Can a visitor choose which model answers?

Yes. The default is Auto, which runs the fallback chain described above. A visitor can
instead pin a specific model to compare how each behaves on the same question — the
smaller ones search less thoughtfully, and seeing that is more convincing than reading
a benchmark table.

A pinned model is used on its own with no silent substitution. If it is rate-limited
the error says so by name and suggests switching back to Auto, because the entire point
of pinning is to observe that model rather than whatever the app decided to use
instead. Auto mode emits the model that actually served the answer, so the fallback
chain is visible rather than a black box.

The model id is validated by **exact membership** in an allowlist, never sanitised. It
is interpolated into the Gemini request URL, so a crafted value containing a query
separator or a path traversal could restructure that URL and leak the API key into
somebody else's request. Rejecting anything not in the list is the only safe check.

## How does search handle the visitor's own upload alongside the preloaded ones?

Both namespaces are searched in parallel and the results merged — but not by a plain
global re-rank, which is the obvious approach and is wrong.

The preloaded corpus is much larger than a freshly uploaded document. Merging everything
and taking the global top six lets a one-passage upload score respectably and still lose
every slot. The failure this actually produced: a recruiter uploaded a job description,
asked how the profile compared against it, and was told no job description had been
provided. That is the worst class of bug, because the answer is fluent, confident, and
sounds like a reasonable thing for the system to say.

So a couple of slots are reserved for the visitor's own documents whenever they have
passages that cleared the relevance floor, and the rest are filled by score across both
namespaces. The floor still applies, so reservation promotes plausible matches and never
noise. The system instruction carries a matching guardrail: if the user refers to a
document they uploaded and search does not surface it, check what is indexed before
claiming it is missing.

The general lesson is about federated retrieval: when one corpus is far larger than
another, relevance ranking alone silently favours size.

## What are the retrieval knobs, and who sets them?

The parameters that actually change answer quality in this system are on the retrieval
side, not the generation side.

**Top k** — how many passages a search returns — is set by the model, not by me. It is
a parameter on the `search_document` tool, defaulting to 6 and clamped between 1 and 12
in code. A broad question can ask for more context, a narrow one for less. Clamping
matters: an unclamped k lets the model request enough passages to blow past the context
window, and a k of zero returns nothing at all.

**The similarity threshold** is fixed at 0.25 cosine similarity. Below that, results are
noise, and passing noise to the model invites it to answer from something irrelevant
rather than admit the document does not cover the question. Returning an empty result
with a note saying so produces a better answer than returning six bad passages.

**Chunk size and overlap** are fixed at roughly 1100 and 180 characters. These have more
influence on answer quality than any generation parameter, because a passage that
splits a fact in half cannot be retrieved usefully at any temperature.

Top-k, the relevance floor and the turn budget are all exposed in the UI, each with a
written explanation of what it does, why it exists, and what raising or lowering it
will do to the next answer. Making the knobs adjustable and explained turns the demo
into something a visitor can experiment with: pin top-k to 2 and watch the agent
compensate by searching repeatedly until it runs out of turns; raise the floor and
watch it start saying the document does not cover the question.

Every value is clamped twice — once in the browser so the UI cannot express an invalid
setting, and again on the server because the browser is not a trustworthy source. The
turn budget in particular has a hard server-side ceiling: unbounded, one visitor could
spend the whole day's model quota in a handful of requests.

The turn budget floors at 2 rather than 1 for a structural reason. The final turn is
deliberately sent without tool definitions, so the model must answer rather than call
one more tool the loop has no budget to execute. A maximum of 1 would therefore mean
the agent never receives tools at all and answers from nothing — the opposite of what
someone lowering the setting is trying to observe. Two means one round of searching,
then an answer. A round can contain more than one search, because the model is allowed
to issue tool calls in parallel.

## How does the model cascade work?

The app tries `gemini-flash-latest` first, then `gemini-3.6-flash`, then
`gemini-3.1-flash-lite`. If a model returns an error the loop moves to the next one.
The order is chosen by measured availability and quota generosity rather than by
benchmark score, and the lite model sits last because its free quota is the largest —
when everything above is exhausted, a slightly weaker answer beats an error page.

The cascade also remembers which models are currently rate-limited and skips them until
their reported retry time passes. Without that memory, every request after a model
exhausts its daily quota pays a wasted network round trip to that dead model before
falling through to a working one. With three models in the chain that is most of a
second added to every answer, for the rest of the day.

The cascade also distinguishes failure types. If every model failed and at least one
failure was a 429, the error surfaced to the user says the free tier is exhausted and
resets daily, rather than a raw HTTP status. A fallback chain that reports the wrong
reason is worse than no fallback chain, because it sends you debugging the wrong thing.
`gemini-2.5-flash` was in an earlier version of this list and had to be removed: it now
returns 404 for newly created API keys.

## How does streaming work end to end?

Three streams chained together. Gemini streams its response as Server-Sent Events when
called with `alt=sse`. The agent loop parses those frames and re-emits its own typed
events — `trace`, `text`, `citations`, `error`, `done` — into a `ReadableStream`. The
browser reads that stream with `fetch` and an async generator, and applies each event
to React state.

`fetch` rather than the browser's `EventSource` API, because the request is a POST with
a JSON body and a custom session header, and `EventSource` supports none of those. The
response also sets `X-Accel-Buffering: no`, without which Vercel's edge proxy buffers
the response and the user sees nothing until the answer is complete — which defeats the
entire point of streaming.

## What bug did the SSE parser have, and how was it found?

The classic one, and it appeared as a symptom that looked like a model problem. An
answer ended mid-sentence: "The uploaded document is a professional resume and". My
first instinct was that the model had stopped early.

It had not. Server-Sent Events are newline-delimited, so the parser splits the buffer
on `\n` and keeps the last incomplete fragment for the next read. When the final frame
arrives without a trailing newline — which is common — that complete frame sits in the
buffer forever and is silently dropped. The fix is to flush whatever remains after the
read loop ends. The same bug existed in both the server-side and browser-side parsers,
because I had written the same loop twice.

Worth noting how it was caught: not by a unit test, but by reading the actual output of
a real request carefully enough to notice the sentence did not end. A test asserting
"response is non-empty" would have passed.

## How do citations work?

Every passage returned by a search is assigned a number the first time it appears, and
the same passage keeps its number if a later search returns it again. Those numbers go
to the model inside the tool result, and the system instruction asks it to cite with
bracketed markers such as `[1]` or `[2][3]`.

When the answer is complete, the code scans the finished text for markers and emits
only the passages actually referenced. Retrieval routinely returns six passages while
the answer uses three; showing all six buries the evidence that matters. If the model
cited nothing, all retrieved passages are shown, so the evidence is always inspectable.

In the UI each marker renders as a small clickable chip that scrolls to the
corresponding source card, which shows the filename, page number, similarity score and
the passage text. A recruiter can check any claim in two clicks.

## Why is the markdown renderer hand-written instead of a library?

Because the text arrives token by token. On any given frame the content may end in a
half-written `**bold`, an unclosed code fence, or a list item with no text yet. Most
markdown libraries assume a complete document and will render literal asterisks, or
flicker as a partial construct resolves.

The renderer here parses defensively: an unclosed `**` still renders as bold, an
unterminated code fence still renders as a code block, and citation markers are
recognised and turned into interactive chips, which no general-purpose markdown library
would do. It handles the subset a grounded answer actually uses — headings, lists,
code, emphasis, blockquotes, citations — and nothing else. Roughly 200 lines against a
dependency that would have solved a different problem.

## Why does the UI show the agent's trace?

Because "agentic" is otherwise an unverifiable claim. Above each answer is a collapsible
strip showing every tool call the model made: the search query it wrote, how many
passages came back, the top similarity score, and how long it took. If the agent
searched twice because the first attempt was weak, that is visible. If it answered
without searching, that is visible too.

This is a design position, not a debugging feature. Systems that hide their reasoning
behind a spinner ask users to trust them. Showing the decision trail lets a recruiter
evaluate whether the system did something intelligent, and lets me demonstrate the
behaviour rather than assert it in a bullet point.

## How are anonymous visitors isolated from each other?

Every row in the database carries a session ID: a version-4 UUID generated in the
browser and kept in `localStorage`. Uploads write it, searches filter on it inside the
SQL function, and deletes are scoped to it. The result is that two people using the
demo at the same time cannot see each other's documents.

I am precise about what this is: it is an isolation mechanism, not an authorisation
boundary. A UUID in `localStorage` is unguessable in practice, which is exactly the
property needed to keep one anonymous visitor's upload out of another's answers. It
would not survive a determined attacker, and it is not meant to. Real accounts would
mean Supabase Auth with row-level security policies keyed on the authenticated user ID.
Stating that plainly is better engineering than implying the demo has security it does
not have.

## Why is the Supabase service-role key never in the browser?

The service-role key bypasses row-level security entirely — anyone holding it can read
and write every row in the database. It is read only inside server-side route handlers,
and neither it nor the Gemini key is prefixed `NEXT_PUBLIC_`, which is the specific
mechanism by which a Next.js variable would be inlined into the client bundle. The
browser never talks to Supabase or to Gemini directly; it only talks to this app's own
API routes. Row-level security is enabled on every table with no permissive policy, so
even an accidentally leaked anonymous key reads nothing.

## How is the demo protected from draining the free quota?

A fixed-window rate limit enforced in Postgres: 25 messages per 10 minutes and 10
uploads per hour. The counter lives in the database rather than in memory because every
serverless invocation may land on a fresh instance, so process memory is not shared
state and an in-memory counter would reset constantly.

It is counted against a hash of the caller's IP address, and this is the part worth
explaining. The obvious key is the session id — and it is useless, because the session
id is a UUID the browser generates, so rotating it resets the counter. I confirmed that
by doing it: five uploads under five fresh ids, five successes. Against a free tier
where two models allow twenty requests a *day*, a short loop could take the demo down
for everyone. The address is the client-visible identity that cannot be changed at
will. It is hashed before storage, because an IP is personal data and counting requests
does not require keeping it in plaintext.

The trade-off is that visitors behind one NAT — an office, a university — share a
budget. For a portfolio demo that is the right side of the trade.

The limiter fails open. If the rate-limit query itself errors, the request is allowed
through. A protective mechanism that takes the whole demo offline when it hiccups is
worse than the abuse it prevents — though it does mean the weakest control has the
weakest failure mode, which is a deliberate choice rather than an oversight.

## Why does PDF parsing use unpdf instead of pdf-parse?

`pdf-parse` is the most popular Node PDF text extractor and it cannot be used here: it
reads a bundled test PDF at import time, which throws the moment it is bundled into a
serverless function. This is a well-known failure that only appears after deployment,
which makes it exactly the kind of thing worth getting right before building a UI on
top of it. `unpdf` ships a build of Mozilla's pdf.js compiled for serverless runtimes
and has no import-time filesystem access. Both it and the DOCX parser are marked as
external packages in the Next.js config so the bundler leaves them intact.

## How is DOCX handled?

Via `mammoth`, converting to HTML and then to Markdown-ish text rather than using its
raw-text extractor. Raw text would discard the heading structure, and headings are what
the chunker uses to keep sections intact and what get prepended to each passage before
embedding. Throwing away structure at the parsing stage would quietly degrade retrieval
quality several steps later.

## What happens to a scanned PDF?

It is rejected with an explicit message saying the file has no extractable text layer
and is most likely a scan. Text extraction only sees a text layer; a scanned page is an
image and yields nothing. The alternative — indexing an empty document and then
answering "I could not find that in the document" to every question — would be worse,
because the failure would look like a retrieval bug rather than an unsupported input.
Explicit failure beats silent uselessness.

## How is the system observed in production?

Every question becomes a Langfuse trace named `DocMind`, grouped by the visitor's
session so the view is a whole conversation rather than a pile of unrelated questions —
how someone explored a document is more informative than any single question they
asked.

Inside a trace, the agent loop is laid out as it actually ran: one generation per model
turn, carrying the model that served it and its token counts, and one span per
retrieval, carrying the query the model wrote, how many passages cleared the relevance
floor, the top similarity score and which documents they came from. In a RAG system
retrieval is where answers are won or lost, so that span is the first thing to read when
an answer is wrong. The trace closes with the finished answer and how many of the
retrieved passages it actually cited — a two-out-of-six ratio says something different
about retrieval quality than six-out-of-six does.

The model recorded on each generation is the one that really served, not the one that
was requested. In Auto mode the cascade may fall through several models before one
answers, so recording "auto" would make token and cost attribution meaningless. The
real id is only known after the call resolves, so it is written when the generation
closes rather than when it opens.

Ingestion is traced too: document type, character count, passage count, parser warnings,
and a span around the embedding fan-out.

## Why does tracing need an explicit flush, and why is that the interesting part?

Because a serverless function freezes the instant its response finishes. Tracing SDKs
batch events and send them on a timer to avoid a network round trip per event — which
is the right design on a long-lived server and completely wrong here, because the timer
never fires again once the instance is frozen. Anything still queued is silently lost.

So the app sends eagerly and awaits an explicit flush before the response stream closes.
This is the difference between tracing that works in production and tracing that works
only on a development server, and it fails in the least helpful way possible: perfectly
locally, then partially and unpredictably once deployed.

Tracing is also optional by construction. With no credentials configured every call is a
no-op and the app is unchanged, and no tracing call is allowed to throw into a request
path. Observability that can take the product down when the observability vendor has a
bad day is a liability rather than an asset.

## Why does the app show different things at different URLs?

Two audiences, one deployment. Opened through the portfolio it is Kannan's
assistant: his profile, his skills and this architecture write-up are preloaded, and
his phone number and email are available. Opened at its own URL it is a blank
document Q&A tool — nothing preloaded, upload something to begin — because there it
is a public endpoint that anyone, and anything, can talk to.

Both behaviours come from one check. The client reports the origin of the top-level
page it is running under: `window.location.ancestorOrigins[0]` when embedded in an
iframe, its own origin otherwise. The server matches that against an allowlist and
that single boolean decides two things — whether the preloaded namespace is
searchable at all, and whether contact details survive redaction. An unset allowlist
means restricted mode everywhere, so losing the configuration fails closed.

**What this does and does not stop.** The origin arrives in a request header set by
the page, so a client that is not a browser can simply assert it — one `curl -H` and
the preloaded documents are readable. It stops crawlers, scrapers, link previews and
anyone arriving at the public URL, which is the traffic that actually exists. It does
not stop someone who reads this repository and sends a header, and the same
information is published on the portfolio anyway.

Making it robust would need a secret neither side exposes: the portfolio's server
minting a short-lived signed token that DocMind verifies. That is not available here
— the portfolio is a static single-page app with no server to hold a key, and a
secret shipped in its client bundle is not a secret. So the honest description is a
gate proportionate to the exposure, not an access control, and the contact redaction
underneath it is the layer that genuinely holds: that data never enters the model's
context at all.

There is a nice side effect. With nothing indexed, the agent is told so up front and
its tools are withheld, so it answers immediately instead of searching, finding
nothing, rephrasing, searching again and only then concluding the corpus is empty.
That is three round trips saved on a daily model quota, and a better answer.

## Why can't anyone write to the preloaded documents?

The shared namespace is identified by a fixed UUID, and that UUID is a constant in a
public repository. Reads from it are gated by origin, but the write path was
initially open — which meant anyone who read the source could POST a document under
that id and have it appear, permanently and to every visitor, as part of Kannan's
indexed profile. The agent would then cite it as fact.

I found this by asking what the public repo gives away, and confirmed it by doing
it: a made-up claim about salary expectations went straight into the corpus.

Writes to that namespace now require a secret from an environment variable,
compared in constant time, and an unset variable disables seeding rather than
opening it. Ordinary visitors uploading their own documents are unaffected; only the
shared namespace is gated.

The general lesson: a public identifier is not a permission. Choosing a well-known
constant for a namespace is fine, but every write path to it needs its own check —
and open-sourcing a project changes the threat model of every constant in it.

## How are direct contact details handled?

The preloaded profile contains a phone number and an email address. Those follow the
same origin rule as the documents themselves — available through the portfolio,
withheld at the public URL.

The mechanism matters more than the policy. The obvious implementation is a line in the
system instruction saying not to reveal the number — and that is close to useless,
because the passage containing the number still enters the model's context, one
well-phrased question away from coming back out. Instead the passage is rewritten before
it reaches the model **and** before it reaches the citation panel, so there is nothing to
extract. Asked to "quote the document exactly", the model quotes the placeholder,
because the placeholder is all it was given.

Trust is decided server-side from the origin the page is running under — its own, or the
parent's when embedded in an iframe — matched against an allowlist in an environment
variable. An unset variable withholds everywhere, so losing the configuration fails
closed rather than open.

This is a disclosure preference, not a security control, and it is worth being honest
about which: the origin comes from the browser and could be forged, and the same details
are published on the portfolio regardless. What it prevents is casual scraping of a
public endpoint, which is the threat that actually exists.

## Why does the answer change depending on which country the visitor is in?

Kannan's portfolio has shipped two editions of his profile for a while: a Dubai one by
default, and an India one when the visitor is geolocated in India or arrives via `/ind`.
A recruiter in Chennai reading "requires UAE employment visa sponsorship" is reading a
document that was clearly not written for them. DocMind mirrors the same split.

**This is deliberately a second, independent signal — not an extension of the origin
trust described above.** The two answer different questions:

| | question it answers | source | consequence |
|---|---|---|---|
| Trust | *May* this visitor see the preloaded profile and the contact details in it? | `x-embed-origin` vs an allowlist | empty app, or Kannan's assistant |
| Region | *Which* availability story is the honest one for them? | `x-vercel-ip-country` | Dubai relocation, or Chennai-based |

Collapsing them into one flag would be a bug with a plausible-sounding rationale. An
Indian recruiter arriving through the portfolio iframe is **trusted** — they get the
phone number — and **Indian** — they should never see the Dubai framing. Both checks run,
and neither implies the other.

### Why the corpus was split rather than the prompt patched

The first instinct is a line in the system instruction: *do not mention Dubai*. That
fails for exactly the reason the contact-detail rule fails, and it is the same lesson
twice — retrieved passages are rendered in the citation panel. A perfectly obedient model
that never types the word "Dubai" still leaves a card on screen headed *"Is Kannan
available to relocate to Dubai, and what is his visa status?"*, quoting the visa text
verbatim. The prompt cannot reach that panel.

The second instinct is redaction, reusing the machinery that removes phone numbers. That
is wrong here too, but for a different reason: a phone number is a token inside otherwise
neutral prose, so cutting it out leaves a readable sentence. Region framing is *the whole
paragraph*. Redacting it word by word produces mangled text and a model trying to answer
from it.

So the preloaded profile was **partitioned instead**. Everything region-specific moved out
of the shared profile into two small edition documents, and the shared profile became
genuinely neutral:

```
docs/seed/
  Kannan Santharam — Professional Profile.md          ← neutral: experience, achievements
  Kannan Santharam — Skills and Proficiency.md        ← neutral
  Kannan Santharam — Dubai Relocation and Availability.md
  Kannan Santharam — India Availability.md
```

Retrieval then drops the edition that does not apply, in `runSearch`, **before**
`addCitations` builds the panel — one filter covering both what the model reads and what
the visitor sees. `list_sections` and the sidebar apply the same exclusion, or the wrong
edition would stay unsearchable while still announcing itself by name.

Two details that are easy to get wrong:

- **The filter is scoped to the shared namespace only.** Matching on content instead
  would catch a recruiter's own uploaded job description for a Dubai role and silently
  drop it — the same class of failure as the reserved-slot bug, where the agent insisted
  a document it had indexed did not exist.
- **It keys off exact filenames**, and `scripts/verify.mjs` asserts those filenames still
  exist in `docs/seed/`. Renaming a seed file would otherwise break the filter silently:
  it would match nothing, and India visitors would quietly start seeing the Dubai edition
  again. A filter that fails open is worse than no filter, because nobody looks at it.

The system instruction still gets an India-specific block, but it is a backstop rather
than the mechanism — it exists because the model has its own idea of what a "relocation"
answer sounds like, and because a stray mention can arrive through conversation history
rather than through a passage.

### Testing something you cannot be in two places for

`x-vercel-ip-country` does not exist on a dev server, and no developer can change which
country they are in to check a deploy. Without an escape hatch the India path would be
unreachable and therefore unverifiable. So the client forwards a `?region=in` from its own
URL as `x-region-override`, which takes precedence over the header, and the resolved
region is written to every Langfuse trace beside `origin` — the only way to confirm the
geo header genuinely arrives in production rather than assuming it does.

That override is trivially forgeable, and unlike the trust signal, that costs nothing:
both editions are already public on the portfolio. Region is editorial, not protective, so
a signed token would be effort spent guarding something that is not a secret. It also
gives the portfolio a clean way to forward its own `/ind` choice — frame
`…/?region=in` and the iframe agrees with the page around it.

## What are the honest limitations of this system?

**No image or diagram understanding.** Text only. Charts, screenshots and diagrams in a
PDF are ignored, and images in a DOCX are stripped along with their alt text. The
embedding model takes text and nothing else.

**No OCR**, so scanned documents are rejected rather than processed.

**Tables lose structure.** Cell text survives, the grid does not.

**The session ID is isolation, not authorisation**, as described above.

**Free-tier quotas are real.** Heavy use in one day can exhaust the daily model quota
for everyone, which the fallback chain mitigates but cannot eliminate.

**Fixed retrieval strategy.** Dense vector search only. No BM25 keyword search, no
hybrid fusion, no cross-encoder reranking. Those improve retrieval on hostile corpora
and are the obvious next step, but they were not needed to make this system work well
on the documents it targets.

## What would I build next?

Multimodal ingestion first, because it addresses the biggest real gap. The Gemini chat
models accept PDFs natively and can describe figures, so a page with little extractable
text could be sent to the model for transcription and figure description, and that
description embedded as an ordinary passage. Citations would keep working, pointing at
"Figure 3, page 4".

After that, hybrid retrieval: BM25 alongside dense search with reciprocal rank fusion,
then a cross-encoder reranker over the merged candidates. Dense search alone struggles
with exact identifiers — part numbers, clause references, names — which keyword search
handles trivially. Then evaluation: a small set of question-and-expected-passage pairs
scored on retrieval hit rate, so changes to chunk size or embedding dimension can be
measured rather than guessed at.

## What did I learn building this?

That the constraints that actually shape a system are rarely the ones anticipated at
design time. I expected to be limited by function duration and vector search
performance. I was limited by API requests per minute and requests per day — facts
discovered by measuring, not by reading documentation. Every number in this document
came from an actual API response: the 100 requests-per-minute embedding quota, the 429
on request 99, the 20-requests-per-day cap on the preview model, the exact embedding
dimensions.

I also learned how much of retrieval quality is decided before the vector database is
ever involved. Chunk boundaries, whether headings survive parsing, whether an embedding
is renormalised after truncation — these determine whether the right passage can be
found at all. The vector store is the least interesting part of a RAG system.

And that streaming interfaces fail in ways tests do not catch. A dropped final SSE
frame produces an answer that is complete, coherent, and quietly missing its last
sentence. No assertion about response length or status code would find it. It was found
by reading the output.

## Stack summary

**Frontend:** React 19, Next.js 16 App Router, Tailwind CSS v4, TypeScript, streaming
via fetch and ReadableStream, hand-written incremental markdown renderer, dark and
light themes sharing the portfolio's design tokens.

**Backend:** Next.js route handlers on Vercel serverless functions, Server-Sent Events,
Postgres-backed rate limiting.

**AI:** Google Gemini — `gemini-3.6-flash` with function calling for the agent loop,
`gemini-embedding-001` at 768 dimensions for retrieval, with a three-model fallback
chain.

**Data:** Supabase Postgres with the pgvector extension, HNSW index on cosine distance,
retrieval encapsulated in a SQL function, row-level security enabled.

**Parsing:** unpdf for PDF, mammoth for DOCX, native handling for text, Markdown and
pasted content.

**Observability:** Langfuse — one trace per question grouped by session, a generation per
agent turn with real model attribution and token counts, a span per retrieval, explicit
flushing for the serverless runtime.

**Engineering:** free-tier quotas measured against the live API rather than assumed,
sliding-window client-side rate limiting, model fallback chain, rollback on failed
ingestion, session-scoped data isolation, preflight verification script.
