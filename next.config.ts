import type { NextConfig } from "next";

const noStoreHeaders = [
  {
    key: "Cache-Control",
    value: "no-store, no-cache, must-revalidate, max-age=0",
  },
  {key: "Pragma", value: "no-cache"},
  {key: "Expires", value: "0"},
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return ["/", "/login", "/change-password"].map((source) => ({
      source,
      headers: noStoreHeaders,
    }));
  },
};

export default nextConfig;
