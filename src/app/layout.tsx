import type { Metadata, Viewport } from 'next';
import { ThemeProvider, themeBootstrapScript } from '@/context/ThemeContext';
import './globals.css';

export const metadata: Metadata = {
  // Generic on purpose: this metadata is what the public URL shows, and there the
  // app is a blank document Q&A tool. The Kannan-specific framing appears in the
  // UI only when it is opened through the portfolio.
  title: 'DocMind — Agentic RAG over your documents',
  description:
    'Upload a PDF, DOCX, Markdown file or paste text, then ask questions. A tool-calling Gemini agent decides when to search, retrieves from Supabase pgvector, and cites the exact passage behind every claim.',
  authors: [{ name: 'Kannan Appiya Santharam' }],
  openGraph: {
    title: 'DocMind — Agentic RAG over your documents',
    description:
      'Tool-calling retrieval agent: Gemini function calling + pgvector + Next.js. Upload a document and ask.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b0e14' },
    { media: '(prefers-color-scheme: light)', color: '#f8fafd' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="h-full antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
