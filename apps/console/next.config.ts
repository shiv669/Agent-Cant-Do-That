import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack: (config, { dev }) => {
    if (dev) {
      // Avoid intermittent missing chunk errors from filesystem cache races on Windows.
      config.cache = {
        type: 'memory'
      };
    }
    return config;
  }
};

export default nextConfig;
