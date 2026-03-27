import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  onDemandEntries: {
    // Keep dev entries alive longer to avoid refresh races that can surface
    // transient /_next/static chunk and css 404s on slower Windows FS.
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 12
  },
  async headers() {
    if (process.env.NODE_ENV !== 'development') {
      return [];
    }

    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0'
          },
          {
            key: 'Pragma',
            value: 'no-cache'
          },
          {
            key: 'Expires',
            value: '0'
          }
        ]
      }
    ];
  },
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
