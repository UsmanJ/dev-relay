import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  turbopack: { root: import.meta.dirname },
  // Local-only tool: no telemetry, no image optimisation service needed.
  images: { unoptimized: true },
};

export default nextConfig;