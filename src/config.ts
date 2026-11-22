function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${v}"`);
  return n;
}

export const config = {
  /** Path to the SQLite database file. */
  dbPath: process.env.TINYRSS_DB ?? "./data/tinyrss.db",
  port: num("PORT", 8080),
  hostname: process.env.HOST ?? "0.0.0.0",
  /** Minutes between refreshes of a single feed. */
  fetchIntervalMinutes: num("TINYRSS_FETCH_INTERVAL", 30),
  /** Read, unstarred items older than this are deleted. 0 disables purging. */
  retentionDays: num("TINYRSS_RETENTION_DAYS", 90),
  /** How many feeds are fetched in parallel. */
  fetchConcurrency: num("TINYRSS_FETCH_CONCURRENCY", 6),
  /** Optional: if set, the server makes the stored credentials match these on startup. */
  username: process.env.TINYRSS_USERNAME || undefined,
  password: process.env.TINYRSS_PASSWORD || undefined,
  userAgent: process.env.TINYRSS_USER_AGENT ?? "tinyrss/0.1 (+https://github.com/; single-user feed reader)",
};
