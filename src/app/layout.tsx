import type { Metadata, Viewport } from 'next';
import { ThemeProvider, themeBootstrapScript } from '@/context/ThemeContext';
import './globals.css';

export const metadata: Metadata = {
  title: 'DocMind — Ask anything about Kannan Santharam',
  description:
    "Kannan Santharam's professional profile, indexed and answerable. A tool-calling Gemini agent decides when to search, retrieves from pgvector, and cites the passage behind every claim. Upload a job description and ask how he measures against it.",
  authors: [{ name: 'Kannan Appiya Santharam' }],
  openGraph: {
    title: 'DocMind — Ask anything about Kannan Santharam',
    description:
      'Senior Lead Software Engineer, 10.5+ years, relocating to Dubai. Ask his profile anything — every answer cites its source.',
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
