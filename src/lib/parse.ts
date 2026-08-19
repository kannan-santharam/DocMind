import type { SourceKind } from './types';

export interface ParsedDocument {
  /** Plain text, page breaks marked with the \f sentinel so chunking can map pages. */
  text: string;
  pageCount: number | null;
  sourceKind: SourceKind;
  /**
   * What the parser could not read — pages with no text layer, images it could
   * only record by name. Surfaced to the user at upload and stored so the agent
   * can say which parts of a document it cannot see, rather than answering as if
   * the document were complete.
   */
  notes: string[];
}

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // Vercel caps a serverless request body at ~4.5MB.
export const PAGE_BREAK = '\f';

export const ACCEPTED_MIME: Record<string, SourceKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
};

export const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md', '.markdown'];

export class ParseError extends Error {}

function kindFromFilename(filename: string): SourceKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.txt')) return 'text';
  return null;
}

/**
 * PDF text extraction.
 *
 * `unpdf` rather than `pdf-parse`: pdf-parse reads a bundled test PDF at import
 * time, which throws the moment it is bundled into a serverless function.
 * `unpdf` ships a pdfjs build compiled for exactly this environment.
 */
async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text, totalPages } = await extractText(pdf, { mergePages: false });

  const pages = Array.isArray(text) ? text : [text];
  const joined = pages.map((page) => page.trim()).join(PAGE_BREAK);

  if (!joined.replace(/[\s\f]/g, '')) {
    throw new ParseError(
      'This PDF has no extractable text layer, so there is nothing to index — it is almost certainly a scan or a set of page images. Text extraction cannot read pixels, and OCR is out of scope for this demo. Try a PDF exported from a word processor rather than one produced by a scanner.',
    );
  }

  // A partly-scanned PDF is the dangerous case: it indexes fine and answers
  // confidently while silently missing whole pages. Record the gap.
  const blankPages = pages
    .map((page, index) => (page.trim() ? null : index + 1))
    .filter((page): page is number => page !== null);

  const notes = blankPages.length
    ? [
        `${blankPages.length} of ${pages.length} pages have no extractable text (page ${blankPages.join(', ')}) and are not indexed — most likely scans or full-page images.`,
      ]
    : [];

  return { text: joined, pageCount: totalPages ?? pages.length, sourceKind: 'pdf', notes };
}

/**
 * DOCX -> markdown-ish text.
 *
 * mammoth's HTML output is converted rather than using `extractRawText`, because
 * raw text throws away the heading structure the chunker relies on to keep
 * sections intact.
 */
function htmlToMarkdown(html: string): string {
  return html
    // Images are stripped along with everything else by the tag sweep below, and
    // their alt text goes with them. Alt text is often the only description of a
    // chart or diagram in the file, so promote it to real text first.
    .replace(/<img[^>]*\balt=["']([^"']+)["'][^>]*>/gi, (_m, alt: string) => `\n\n[Image: ${alt.trim()}]\n\n`)
    .replace(/<h([1-6])[^>]*>(.*?)<\/h\1>/gis, (_m, level: string, inner: string) =>
      `\n\n${'#'.repeat(Number(level))} ${stripTags(inner)}\n\n`,
    )
    .replace(/<li[^>]*>(.*?)<\/li>/gis, (_m, inner: string) => `\n- ${stripTags(inner)}`)
    .replace(/<\/(p|div|tr|blockquote|ul|ol|table)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

async function parseDocx(bytes: Uint8Array): Promise<ParsedDocument> {
  const mammoth = (await import('mammoth')).default;
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
  const text = htmlToMarkdown(value);

  if (!text) throw new ParseError('This .docx file contains no readable text.');

  const totalImages = (value.match(/<img/gi) ?? []).length;
  const described = (text.match(/\[Image: /g) ?? []).length;
  const undescribed = totalImages - described;

  const notes = undescribed > 0
    ? [
        `${undescribed} image${undescribed === 1 ? '' : 's'} in this document ${undescribed === 1 ? 'has' : 'have'} no alt text and could not be indexed. Only text and image descriptions are searchable.`,
      ]
    : [];

  return { text, pageCount: null, sourceKind: 'docx', notes };
}

export async function parseUpload(file: File): Promise<ParsedDocument> {
  if (file.size === 0) throw new ParseError('That file is empty.');
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ParseError(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is 4MB — Vercel caps serverless request bodies.`,
    );
  }

  // Extension first: browsers report .md as text/plain, and .docx sometimes as octet-stream.
  const kind = kindFromFilename(file.name) ?? ACCEPTED_MIME[file.type];
  if (!kind) {
    throw new ParseError(
      `Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(', ')}.`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  if (kind === 'pdf') return parsePdf(bytes);
  if (kind === 'docx') return parseDocx(bytes);

  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) throw new ParseError('That file contains no readable text.');
  return { text, pageCount: null, sourceKind: kind, notes: [] };
}

export function parsePastedText(raw: string): ParsedDocument {
  const text = raw.trim();
  if (!text) throw new ParseError('Nothing to ingest — the text box is empty.');
  if (text.length > 400_000) {
    throw new ParseError('Pasted text is capped at 400,000 characters.');
  }
  return { text, pageCount: null, sourceKind: 'paste', notes: [] };
}
