import type { NextConfig } from 'next';

// CHECK_BUILD routes the build output to `.next-check` so a verification build
// (e.g. the pre-push hook) never clobbers a running `next dev` in `.next`.
const nextConfig: NextConfig = {
  distDir: process.env.CHECK_BUILD === '1' ? '.next-check' : '.next',
};

export default nextConfig;
