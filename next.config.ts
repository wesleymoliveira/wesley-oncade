import type { NextConfig } from 'next';

const config: NextConfig = {
  // API only: there are no pages in this project.
  poweredByHeader: false,
  // This folder is the project root, whatever lockfiles exist above it.
  turbopack: { root: import.meta.dirname },
};

export default config;
