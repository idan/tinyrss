import { Hono } from "hono";
import type { BackupSettings } from "./backup.ts";
import type { DB } from "./db.ts";
import { greaderApi } from "./greader.ts";
import { webUi } from "./web.ts";

export interface AppOptions {
  /** Shown as a banner in the web UI. */
  warning?: string | null;
  /** Enables the backups section of the web UI. */
  dbPath?: string;
  backups?: BackupSettings;
}

export function createApp(db: DB, opts: AppOptions = {}): Hono {
  const app = new Hono();
  const greader = greaderApi(db);

  app.onError((err, c) => {
    console.error(`${c.req.method} ${new URL(c.req.url).pathname}:`, err);
    return c.text(`Internal error: ${err.message}`, 500);
  });

  app.get("/healthz", (c) => c.text("ok"));

  // Clients differ in what base URL they expect: FreshRSS-style apps want ".../api/greader"
  // (or ".../api/greader.php"), others append "/accounts/ClientLogin" and "/reader/api/0" to the host root.
  app.route("/api/greader", greader);
  app.route("/api/greader.php", greader);
  app.route("/", greader);

  app.route("/", webUi(db, opts));
  return app;
}
