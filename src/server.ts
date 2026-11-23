import { createApp } from "./app.ts";
import { hasCredentials, syncCredentialsFromEnv } from "./auth.ts";
import { config } from "./config.ts";
import { type DB, openDb, SchemaTooNewError } from "./db.ts";
import { applyPendingRestore, backupSettings, hasPendingRestore, startBackupScheduler } from "./backup.ts";
import { startScheduler } from "./fetcher.ts";
import { VERSION } from "./version.ts";
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

let cleanup: (() => void) | null = null;
let signalsInstalled = false;

function installSignalHandlers(log: (msg: string) => void) {
  if (signalsInstalled) return;
  signalsInstalled = true;
  const shutdown = () => {
    log("shutting down");
    cleanup?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Errors where the database needs operator attention (rather than a config fix). */
function needsMaintenance(e: unknown): boolean {
  const msg = (e as Error).message ?? "";
  return e instanceof SchemaTooNewError || /^migration \d+/.test(msg) || /integrity check|not a tinyrss database/.test(msg);
}

export async function serve(opts: { port?: number; hostname?: string; dbPath?: string } = {}): Promise<Bun.Server<undefined>> {
  const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
  installSignalHandlers(log);
  const dbPath = opts.dbPath ?? config.dbPath;
  const port = opts.port ?? config.port;
  const hostname = opts.hostname ?? config.hostname;
  const backups = backupSettings(dbPath);

  let db: DB;
  try {
    const restore = applyPendingRestore(dbPath, backups);
    if (restore.applied) {
      log(`restored staged backup${restore.previous ? `; the previous database was saved to ${restore.previous}` : ""}`);
    }
    db = openDb(dbPath, {
      backupDir: backups.dir,
      onBackup: (file, from, to) => log(`upgrading database schema v${from} → v${to}; backup saved to ${file}`),
    });
  } catch (e) {
    if (!needsMaintenance(e)) throw e;
    return maintenance(e as Error, { dbPath, port, hostname, log, restart: (boundPort) => serve({ ...opts, port: boundPort }) });
  }

  const creds = await syncCredentialsFromEnv(db, { username: config.username, password: config.password });
  if (creds === "created") log("credentials created from TINYRSS_USERNAME / TINYRSS_PASSWORD");
  if (creds === "updated") log("credentials updated from TINYRSS_USERNAME / TINYRSS_PASSWORD; existing sessions were logged out");

  const warning = storageWarning(dbPath);
  if (warning) log(`WARNING: ${warning}`);

  const app = createApp(db, { warning, dbPath, backups });
  const server = Bun.serve({
    port,
    hostname,
    fetch: app.fetch,
    idleTimeout: 120, // refreshing many feeds from the web UI can take a while
  });
  log(`tinyrss ${VERSION} listening on ${server.url} (db: ${dbPath})`);
  if (!hasCredentials(db)) {
    log("WARNING: no credentials configured; set TINYRSS_PASSWORD or run `tinyrss set-password <username>`");
  }
  const stop = startScheduler(db, log);
  const stopBackups = startBackupScheduler(db, backups, log);
  log(
    backups.intervalHours > 0
      ? `backups: every ${backups.intervalHours}h to ${backups.dir}, keeping ${backups.keep}` +
          (backups.s3 ? `, uploading to s3://${backups.s3.bucket}/${backups.s3.prefix}` : " (no off-site copy configured)")
      : "backups: scheduled backups disabled (TINYRSS_BACKUP_INTERVAL_HOURS=0)",
  );

  cleanup = () => {
    stop();
    stopBackups();
    server.stop();
    db.close();
  };
  return server;
}

/**
 * The database can't be used (e.g. it's newer than this release after a rollback, or a
 * migration failed). Instead of crash-looping, which would make the container unreachable,
 * serve an explanatory 503 (also failing the healthcheck) and keep the container running so the
 * operator can use `tinyrss backups` / `tinyrss restore` from a shell. Once a restore is staged,
 * start up normally without needing a container restart.
 */
function maintenance(
  error: Error,
  ctx: { dbPath: string; port: number; hostname: string; log: (msg: string) => void; restart: (port: number) => Promise<unknown> },
) {
  const { log } = ctx;
  log(`ERROR: tinyrss ${VERSION} cannot use the database: ${error.message}`);
  log("running in maintenance mode: fix the problem (e.g. `tinyrss backups`, then `tinyrss restore <name>`) and it will start automatically");
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>tinyrss: maintenance</title>
<body style="font: 15px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem">
<h1>tinyrss is in maintenance mode</h1>
<p>The database can't be used:</p>
<pre style="white-space: pre-wrap; background: #8882; padding: .75rem">${escapeHtml(error.message)}</pre>
<p>Usually this happens after deploying an older release over a database that a newer release already upgraded.
Either deploy the newer release again, or open a shell in the container and restore a backup:</p>
<pre style="background: #8882; padding: .75rem">tinyrss backups
tinyrss restore &lt;name&gt;</pre>
<p>tinyrss starts normally as soon as a restore is staged.</p>
</body>`;
  const server = Bun.serve({
    port: ctx.port,
    hostname: ctx.hostname,
    fetch: () => new Response(page, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Retry-After": "60" } }),
  });
  log(`maintenance page on ${server.url}`);
  const timer = setInterval(() => {
    if (!hasPendingRestore(ctx.dbPath)) return;
    clearInterval(timer);
    log("restore staged; leaving maintenance mode");
    const boundPort = server.port!;
    server.stop(true);
    ctx.restart(boundPort).catch((e) => {
      console.error(`fatal: ${(e as Error).message}`);
      process.exit(1);
    });
  }, 2000);
  cleanup = () => {
    clearInterval(timer);
    server.stop();
  };
  return server;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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
