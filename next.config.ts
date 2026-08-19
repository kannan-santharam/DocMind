import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // unpdf ships a serverless-safe pdfjs build; keep it external so Next does not
  // try to bundle the worker into the route handler chunk.
  serverExternalPackages: ['unpdf', 'mammoth'],
};

export default nextConfig;
