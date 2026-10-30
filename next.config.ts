import type { NextConfig } from "next";

const nextConfig = {
  poweredByHeader: false,
  compress: true,
  // Dev-only: allow the local dev/test hosts for the HMR websocket. Without
  // this the dev runtime's /_next/hmr socket is rejected as cross-origin
  // (127.0.0.1/localhost clients), and a failed dev socket aborts client
  // hydration entirely — pages render SSR-only with no interactivity.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
} satisfies NextConfig;

export default nextConfig;
