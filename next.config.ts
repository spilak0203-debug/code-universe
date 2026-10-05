import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The analyzer needs the real `typescript` package at runtime (lib files, CJS internals).
  serverExternalPackages: ['typescript'],
};

export default nextConfig;
