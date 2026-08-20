import type { NextConfig } from 'next';

/**
 * Origins allowed to frame this app. The portfolio embeds DocMind in a
 * full-screen overlay, so framing must be permitted — but only from there.
 * Reuses TRUSTED_ORIGINS rather than a second list that could drift out of sync.
 */
function frameAncestors(): string {
  const origins = (process.env.TRUSTED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return ["'self'", ...origins].join(' ');
}

const nextConfig: NextConfig = {
  // unpdf ships a serverless-safe pdfjs build; keep it external so Next does not
  // try to bundle the worker into the route handler chunk.
  serverExternalPackages: ['unpdf', 'mammoth'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Clickjacking: only the portfolio may frame this. Note a third-party
          // frame would report its own origin and land in restricted mode
          // anyway, so this is defence in depth rather than the primary control.
          { key: 'Content-Security-Policy', value: `frame-ancestors ${frameAncestors()}` },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          // No camera, mic or geolocation is ever needed here.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
