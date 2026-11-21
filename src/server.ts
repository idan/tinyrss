import { createApp } from "./app.ts";
import { hasCredentials } from "./auth.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { startScheduler } from "./fetcher.ts";

export function serve(opts: { port?: number; hostname?: string; dbPath?: string } = {}) {
  const db = openDb(opts.dbPath ?? config.dbPath);
  const app = createApp(db);
  const server = Bun.serve({
    port: opts.port ?? config.port,
    hostname: opts.hostname ?? config.hostname,
    fetch: app.fetch,
    idleTimeout: 120, // refreshing many feeds from the web UI can take a while
  });
  const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
  log(`tinyrss listening on ${server.url} (db: ${opts.dbPath ?? config.dbPath})`);
  log(`GReader API base URL: ${server.url}api/greader`);
  if (!hasCredentials(db)) log("WARNING: no credentials configured; run `bun run cli set-password <username>`");
  const stop = startScheduler(db, log);

  const shutdown = () => {
    stop();
    server.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

if (import.meta.main) serve();
