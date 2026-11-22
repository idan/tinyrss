import { createApp } from "./app.ts";
import { hasCredentials, syncCredentialsFromEnv } from "./auth.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { startScheduler } from "./fetcher.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * In a container, the database must live on a mounted volume or it is lost on every redeploy.
 * Returns a warning if TINYRSS_EXPECT_VOLUME is set (it is in the Docker image) and the
 * database directory isn't on a mount.
 */
function storageWarning(dbPath: string): string | null {
  if (!process.env.TINYRSS_EXPECT_VOLUME || dbPath === ":memory:" || !existsSync("/proc/self/mountinfo")) return null;
  const dir = dirname(resolve(dbPath));
  const mounts = readFileSync("/proc/self/mountinfo", "utf8")
    .split("\n")
    .map((l) => l.split(" ")[4])
    .filter((m): m is string => !!m && m !== "/");
  const mounted = mounts.some((m) => dir === m || dir.startsWith(m + "/"));
  return mounted
    ? null
    : `${dir} is not a mounted volume, so the database will be lost when the container is recreated. ` +
        `Mount a persistent volume at ${dir}.`;
}

export async function serve(opts: { port?: number; hostname?: string; dbPath?: string } = {}) {
  const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
  const dbPath = opts.dbPath ?? config.dbPath;
  const db = openDb(dbPath);

  const creds = await syncCredentialsFromEnv(db, { username: config.username, password: config.password });
  if (creds === "created") log("credentials created from TINYRSS_USERNAME / TINYRSS_PASSWORD");
  if (creds === "updated") log("credentials updated from TINYRSS_USERNAME / TINYRSS_PASSWORD; existing sessions were logged out");

  const warning = storageWarning(dbPath);
  if (warning) log(`WARNING: ${warning}`);

  const app = createApp(db, { warning });
  const server = Bun.serve({
    port: opts.port ?? config.port,
    hostname: opts.hostname ?? config.hostname,
    fetch: app.fetch,
    idleTimeout: 120, // refreshing many feeds from the web UI can take a while
  });
  log(`tinyrss listening on ${server.url} (db: ${dbPath})`);
  if (!hasCredentials(db)) {
    log("WARNING: no credentials configured; set TINYRSS_PASSWORD or run `tinyrss set-password <username>`");
  }
  const stop = startScheduler(db, log);

  const shutdown = () => {
    log("shutting down");
    stop();
    server.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

if (import.meta.main) {
  serve().catch((e) => {
    const msg = (e as Error).message;
    console.error(`fatal: ${msg}`);
    if (/unable to open database|readonly|permission denied|EACCES/i.test(msg)) {
      console.error(
        `hint: the directory of ${config.dbPath} must be writable by the server's user ` +
          `(uid 1000 in the Docker image). Prefer a named volume over a bind mount, or chown the directory.`,
      );
    }
    process.exit(1);
  });
}
