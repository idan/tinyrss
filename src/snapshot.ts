/** Low-level helpers for database snapshots, shared by migrations and backups. */
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Kinds of backups. "scheduled" and "manual" are rotated; the safety ones are kept longer. */
export type BackupKind = "scheduled" | "manual" | `pre-migration-v${number}-to-v${number}` | "pre-restore";

export const BACKUP_FILE_RE = /^tinyrss-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ)-([a-z0-9-]+)\.db(\.gz)?$/;

export function backupDirFor(dbPath: string, env: Record<string, string | undefined> = process.env): string {
  return env.TINYRSS_BACKUP_DIR || join(dirname(resolve(dbPath)), "backups");
}

export function backupFileName(kind: BackupKind, date = new Date()): string {
  const stamp = date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  return `tinyrss-${stamp}-${kind}.db`;
}

/**
 * Write a consistent copy of the database to `file` using VACUUM INTO (safe while other
 * connections are reading and writing). Writes to a temp file first so a crash never leaves a
 * truncated file with the final name.
 */
export function snapshotTo(db: Database, file: string): string {
  const target = resolve(file);
  if (existsSync(target)) throw new Error(`${target} already exists`);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.partial`;
  rmSync(tmp, { force: true });
  try {
    db.query("VACUUM INTO ?").run(tmp);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return target;
}

/** Make a unique backup path in `dir` (adds a counter if two backups land in the same second). */
export function newBackupPath(dir: string, kind: BackupKind): string {
  const name = backupFileName(kind);
  let path = join(dir, name);
  for (let i = 2; existsSync(path) || existsSync(path + ".gz"); i++) {
    path = join(dir, name.replace(/\.db$/, `-${i}.db`));
  }
  return path;
}
