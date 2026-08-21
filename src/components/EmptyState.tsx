'use client';

import { FileUp, Search, Sparkles, Split } from 'lucide-react';

import type { Region } from '@/lib/region';

const PIPELINE = [
  { icon: FileUp, title: 'Parse', body: 'PDF, DOCX, Markdown or pasted text — extracted server-side.' },
  { icon: Split, title: 'Chunk & embed', body: 'Heading-aware passages, 768-dim Gemini embeddings in pgvector.' },
  { icon: Search, title: 'Agent retrieves', body: 'The model chooses when to search and rewrites the query if results are thin.' },
  { icon: Sparkles, title: 'Answer with citations', body: 'Every claim traced back to the passage it came from.' },
];

/** What a recruiter can do beyond asking about the preloaded profile. */
const NEXT_STEPS = [
  'Upload a job description and ask how Kannan measures against it',
  'Ask for evidence behind any claim — every answer cites its source',
  'Ask how this system itself was built; the architecture write-up is indexed too',
];

const STARTERS = [
  'Summarise this document in five bullets.',
  'What are the key dates and deadlines?',
  'What does it say about pricing or cost?',
  'List every obligation or requirement it places on me.',
];

/**
 * Shown when the only documents indexed are the preloaded ones — the state a
 * recruiter arrives in. Generic prompts ("what are the key dates?") aimed at a
 * professional profile produce a poor first impression, so these are the
 * questions a recruiter would actually ask, plus one about the system itself.
 */
const PROJECT_STARTERS: Record<Region, string[]> = {
  dubai: [
    "What is Kannan's experience with AI and agentic engineering?",
    'How did he cut build times by 96%, and what did it involve?',
    "What is Kannan's Dubai relocation, visa status and notice period?",
    'How was this chatbot built, and why those architecture decisions?',
  ],
  india: [
    "What is Kannan's experience with AI and agentic engineering?",
    'How did he cut build times by 96%, and what did it involve?',
    "Where is Kannan based, and what is his notice period?",
    'How was this chatbot built, and why those architecture decisions?',
  ],
};

/**
 * The one sentence of framing a recruiter reads before asking anything.
 *
 * Region-aware for the same reason retrieval is: a recruiter in Chennai being
 * greeted with "relocating to Dubai" has already been told this page is not for
 * them, and no amount of careful answering afterwards undoes that. The server
 * decides which one applies and sends it down with the document list.
 */
const PROJECT_INTRO: Record<Region, string> = {
  dubai:
    'Kannan Santharam is a Senior Lead Software Engineer with 10.5+ years of experience, relocating to Dubai.',
  india:
    'Kannan Santharam is a Senior Lead Software Engineer with 10.5+ years of experience, based in Chennai, India.',
};

export function EmptyState({
  hasDocuments,
  onlyPreloaded,
  region,
  onPick,
}: {
  hasDocuments: boolean;
  onlyPreloaded: boolean;
  region: Region;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-4 py-10 text-center">
      <div className="relative mb-5 flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl">
        <span className="tech-gradient-bg absolute inset-0" />
        <Sparkles className="relative h-6 w-6 text-white" />
      </div>

      <h2 className="text-brand-gradient text-2xl font-extrabold sm:text-3xl">
        {onlyPreloaded ? 'Ask anything about Kannan' : 'Ask anything about your documents'}
      </h2>
      <p className="mt-2 max-w-lg text-sm leading-relaxed text-[var(--text-sub)]">
        {onlyPreloaded
          ? `${PROJECT_INTRO[region]} His full profile, skills and career history are indexed here — ask anything and every answer cites the passage it came from. The write-up of how this system was built is indexed too, so you can interrogate the engineering as well as the engineer.`
          : hasDocuments
            ? 'Your knowledge base is indexed. The agent decides when to retrieve, searches again when results are weak, and cites every passage it used.'
            : 'Upload a PDF, DOCX, Markdown file or paste text to build a knowledge base. Answers come only from what you provide — nothing else.'}
      </p>

      {hasDocuments ? (
        <div className="mt-7 grid w-full gap-2 sm:grid-cols-2">
          {(onlyPreloaded ? PROJECT_STARTERS[region] : STARTERS).map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => onPick(prompt)}
              className="rounded-xl border border-[var(--border-card)] bg-[var(--bg-card)] px-3.5 py-3 text-left text-xs leading-relaxed font-medium text-[var(--text-sub)] transition-all hover:border-[var(--color-primary)] hover:text-[var(--text-title)]"
            >
              {prompt}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-8 grid w-full gap-2 text-left sm:grid-cols-2">
          {PIPELINE.map((step, index) => (
            <div
              key={step.title}
              className="rounded-xl border border-[var(--border-card)] bg-[var(--bg-card)] p-3.5"
            >
              <div className="mb-1.5 flex items-center gap-2">
                <step.icon className="h-3.5 w-3.5 text-[var(--color-cyan)]" />
                <span className="text-xs font-bold text-[var(--text-title)]">{step.title}</span>
                <span className="ml-auto font-mono text-[0.65rem] text-[var(--text-muted)]">
                  0{index + 1}
                </span>
              </div>
              <p className="text-[0.7rem] leading-relaxed text-[var(--text-muted)]">{step.body}</p>
            </div>
          ))}
        </div>
      )}

      {onlyPreloaded && (
        <ul className="mt-7 w-full space-y-1.5 text-left">
          {NEXT_STEPS.map((step) => (
            <li
              key={step}
              className="flex items-start gap-2 text-[0.72rem] leading-relaxed text-[var(--text-muted)]"
            >
              <span aria-hidden className="mt-[0.15rem] text-[var(--color-cyan)]">
                →
              </span>
              {step}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
