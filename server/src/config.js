export const config = {
  port: parseInt(process.env.DST_PORT || "3002", 10),
  pollInterval: parseFloat(process.env.DST_POLL_INTERVAL || "2.0"),
  perceptionRadius: parseInt(process.env.DST_PERCEPTION_RADIUS || "20", 10),
  maxNearbyEntities: parseInt(process.env.DST_MAX_NEARBY || "30", 10),
  maxQueueSize: parseInt(process.env.DST_MAX_QUEUE || "32", 10),
  leaseTimeoutMs: parseInt(process.env.DST_LEASE_TIMEOUT || "15000", 10),
  waitPollMs: parseInt(process.env.DST_WAIT_POLL_MS || "200", 10),
  waitDefaultTimeout: parseInt(process.env.DST_WAIT_TIMEOUT || "120", 10),
  staleStateThreshold: parseInt(process.env.DST_STALE_THRESHOLD || "10000", 10),
  deepseekUrl: process.env.DEEPSEEK_URL || "https://api.deepseek.com/v1/chat/completions",
  deepseekKey: process.env.DEEPSEEK_API_KEY || "",
};
