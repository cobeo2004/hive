import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  // The rollout builds into another directory and swaps it in, so the running panel keeps serving its own build.
  distDir: process.env.HIVE_BUILD_DIR || ".next",
  env: { NEXT_PUBLIC_LIVE_UPDATES: process.env.VERCEL_ENV === "preview" ? "off" : "on" },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
