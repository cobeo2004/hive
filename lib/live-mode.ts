// next.config.ts turns this off in Vercel preview builds, which never follow live updates.
export const liveUpdates = process.env.NEXT_PUBLIC_LIVE_UPDATES !== "off";
