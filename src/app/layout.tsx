import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';
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
        {/**
          * Visitor analytics, and worth being precise about what they can and
          * cannot see from inside an iframe.
          *
          * Both beacons are same-origin `/_vercel/*` paths, so `connect-src 'self'`
          * passes them untouched — no CSP change was needed, and if one were, that
          * would be the wrong trade. A blocked beacon fails silently, so a console
          * free of CSP errors is part of verifying this works at all.
          *
          * Country comes from the edge, not from the browser: it is IP-derived
          * server-side, which is why `Permissions-Policy: geolocation=()` stays
          * exactly as it is. Those are different mechanisms and only one of them is
          * a permission the visitor should be asked for.
          */}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
