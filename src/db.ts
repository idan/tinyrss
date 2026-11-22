import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Migration, migrations as defaultMigrations } from "./migrations.ts";
import { backupDirFor, newBackupPath, snapshotTo } from "./snapshot.ts";

export type DB = Database;

export class SchemaTooNewError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly appVersion: number,
  ) {
    super(
      `the database has schema version ${dbVersion}, but this version of tinyrss only knows up to ${appVersion}. ` +
        `This usually means an older release was deployed after a newer one had already upgraded the database. ` +
        `Deploy the newer release again, or restore the "pre-migration" backup taken before the upgrade ` +
        `(see \`tinyrss backups\` and \`tinyrss restore\`).`,
    );
    this.name = "SchemaTooNewError";
  }
}

export interface OpenOptions {
  /** Override the migration list (tests). */
  migrations?: Migration[];
  /** Where pre-migration backups go. Defaults to the backup dir next to the database. */
  backupDir?: string;
  /** Called with the path of the pre-migration backup, if one was made. */
  onBackup?: (path: string, from: number, to: number) => void;
}

export function openDb(path: string, opts: OpenOptions = {}): DB {
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    migrate(db, opts.migrations ?? defaultMigrations, {
      backupDir: inMemory ? undefined : (opts.backupDir ?? backupDirFor(path)),
      onBackup: opts.onBackup,
    });
    db.exec("PRAGMA foreign_keys = ON");
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

export function schemaVersion(db: DB): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/**
 * Bring the schema up to date.
 * - Refuses to touch a database newer than the app (e.g. after rolling back a deploy).
 * - Snapshots existing databases before changing them.
 * - Each migration runs in its own IMMEDIATE transaction, re-checking the version inside it so
 *   that concurrent processes (server + CLI) can't apply a migration twice.
 */
export function migrate(
  db: DB,
  migrations: Migration[],
  opts: { backupDir?: string; onBackup?: (path: string, from: number, to: number) => void } = {},
) {
  const target = migrations.length;
  const start = schemaVersion(db);
  if (start > target) throw new SchemaTooNewError(start, target);
  if (start === target) return;

  if (start > 0 && opts.backupDir) {
    const file = snapshotTo(db, newBackupPath(opts.backupDir, `pre-migration-v${start}-to-v${target}`));
    opts.onBackup?.(file, start, target);
  }

  for (let v = start; v < target; v++) {
    const m = migrations[v]!;
    // PRAGMA foreign_keys is a no-op inside a transaction, so it must be toggled outside.
    db.exec(`PRAGMA foreign_keys = ${m.disableForeignKeys ? "OFF" : "ON"}`);
    try {
      db.transaction(() => {
        if (schemaVersion(db) !== v) return; // someone else migrated meanwhile
        if (typeof m.up === "string") db.exec(m.up);
        else m.up(db);
        if (m.disableForeignKeys) {
          const violations = db.query("PRAGMA foreign_key_check").all();
          if (violations.length) {
            throw new Error(`migration ${v + 1} (${m.name}) left ${violations.length} foreign key violation(s)`);
          }
        }
        db.exec(`PRAGMA user_version = ${v + 1}`);
      }).immediate();
    } catch (e) {
      throw new Error(`migration ${v + 1} (${m.name}) failed: ${(e as Error).message}`, { cause: e });
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

export function dbExists(path: string): boolean {
  return path !== ":memory:" && existsSync(path);
}

export function getSetting(db: DB, key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string) {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export function deleteSetting(db: DB, key: string) {
  db.query("DELETE FROM settings WHERE key = ?").run(key);
}
