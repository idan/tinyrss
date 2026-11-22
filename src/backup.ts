/**
 * Backups: consistent local snapshots (rotated), optional off-site copies in S3-compatible
 * storage, and staged restores that are applied on the next server start.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type DB, getSetting, setSetting } from "./db.ts";
import { SCHEMA_VERSION } from "./migrations.ts";
import { BACKUP_FILE_RE, type BackupKind, backupDirFor, newBackupPath, snapshotTo } from "./snapshot.ts";

export { backupDirFor };

/** How many safety backups (pre-migration / pre-restore) to keep, per kind. */
const KEEP_SAFETY = 5;

export interface S3Settings {
  bucket: string;
  prefix: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export interface BackupSettings {
  dir: string;
  /** Hours between scheduled backups; 0 disables them. */
  intervalHours: number;
  /** Number of scheduled/manual backups to keep (locally and in S3). */
  keep: number;
  s3: S3Settings | null;
}

function envNum(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${v}"`);
  return n;
}

export function backupSettings(dbPath: string, env: Record<string, string | undefined> = process.env): BackupSettings {
  const bucket = env.TINYRSS_BACKUP_S3_BUCKET?.trim();
  let prefix = env.TINYRSS_BACKUP_S3_PREFIX ?? "tinyrss/";
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return {
    dir: backupDirFor(dbPath, env),
    intervalHours: envNum(env, "TINYRSS_BACKUP_INTERVAL_HOURS", 24),
    keep: Math.max(1, Math.floor(envNum(env, "TINYRSS_BACKUP_KEEP", 14))),
    s3: bucket
      ? {
          bucket,
          prefix,
          // Unset values fall back to Bun's S3_* / AWS_* environment variables.
          endpoint: env.TINYRSS_BACKUP_S3_ENDPOINT || undefined,
          region: env.TINYRSS_BACKUP_S3_REGION || undefined,
          accessKeyId: env.TINYRSS_BACKUP_S3_ACCESS_KEY_ID || undefined,
          secretAccessKey: env.TINYRSS_BACKUP_S3_SECRET_ACCESS_KEY || undefined,
        }
      : null,
  };
}

function s3Client(s3: S3Settings) {
  return new Bun.S3Client({
    bucket: s3.bucket,
    endpoint: s3.endpoint,
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  });
}

// ---------- listing & rotation ----------

export interface BackupInfo {
  name: string;
  kind: string;
  date: Date;
  size: number;
}

function parseName(name: string): { kind: string; date: Date } | null {
  const m = name.match(BACKUP_FILE_RE);
  if (!m) return null;
  const [d, t] = m[1]!.split("T") as [string, string];
  return { kind: m[2]!.replace(/-\d+$/, ""), date: new Date(`${d}T${t.replace(/-/g, ":")}`) };
}

/** Group key for rotation: scheduled & manual rotate together, safety backups per kind. */
function rotationGroup(kind: string): string {
  if (kind === "scheduled" || kind === "manual") return "regular";
  if (kind.startsWith("pre-migration")) return "pre-migration";
  return kind;
}

function toPrune<T extends { name: string }>(items: T[], keep: number): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const p = parseName(it.name);
    if (!p) continue;
    const g = rotationGroup(p.kind);
    groups.set(g, [...(groups.get(g) ?? []), it]);
  }
  const out: T[] = [];
  for (const [g, list] of groups) {
    list.sort((a, b) => a.name.localeCompare(b.name)); // names sort chronologically
    out.push(...list.slice(0, Math.max(0, list.length - (g === "regular" ? keep : KEEP_SAFETY))));
  }
  return out;
}

export function listLocalBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      const p = parseName(name);
      return p ? { name, ...p, size: statSync(join(dir, name)).size } : null;
    })
    .filter((b): b is BackupInfo => b !== null)
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function pruneLocalBackups(dir: string, keep: number): string[] {
  const doomed = toPrune(listLocalBackups(dir), keep);
  for (const b of doomed) rmSync(join(dir, b.name), { force: true });
  return doomed.map((b) => b.name);
}

export async function listS3Backups(s3: S3Settings): Promise<BackupInfo[]> {
  const client = s3Client(s3);
  const out: BackupInfo[] = [];
  let startAfter: string | undefined;
  for (;;) {
    const res = await client.list({ prefix: s3.prefix, maxKeys: 1000, startAfter });
    const contents = res.contents ?? [];
    for (const o of contents) {
      const name = o.key.slice(s3.prefix.length);
      const p = parseName(name);
      if (p && !name.includes("/")) out.push({ name, ...p, size: o.size ?? 0 });
    }
    if (!res.isTruncated || !contents.length) break;
    startAfter = contents.at(-1)!.key;
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

async function pruneS3Backups(s3: S3Settings, keep: number): Promise<string[]> {
  const client = s3Client(s3);
  const doomed = toPrune(await listS3Backups(s3), keep);
  for (const b of doomed) await client.delete(s3.prefix + b.name);
  return doomed.map((b) => b.name);
}

/** Bun's S3 errors often carry the useful part in `code` (e.g. "ConnectionRefused"). */
export function describeS3Error(e: unknown, s3: S3Settings): string {
  const err = e as { code?: string; message?: string };
  const where = `s3://${s3.bucket}${s3.endpoint ? ` at ${s3.endpoint}` : ""}`;
  const msg = err.message && err.message !== "an unexpected error has occurred" ? err.message : "";
  return [err.code, msg].filter(Boolean).join(": ") + ` (${where})` || String(e);
}

export async function uploadToS3(s3: S3Settings, file: string): Promise<string> {
  const key = s3.prefix + basename(file) + ".gz";
  const gz = Bun.gzipSync(await Bun.file(file).bytes());
  await s3Client(s3).write(key, gz, { type: "application/gzip" });
  return key;
}

// ---------- creating backups ----------

export interface BackupResult {
  file: string;
  size: number;
  pruned: string[];
  s3Key?: string;
  s3Error?: string;
}

/**
 * Snapshot the database into the backup directory, rotate old backups, and upload to S3 if
 * configured. S3 failures don't fail the backup; they're reported and recorded.
 */
export async function createBackup(db: DB, settings: BackupSettings, kind: "scheduled" | "manual"): Promise<BackupResult> {
  let file: string;
  try {
    file = snapshotTo(db, newBackupPath(settings.dir, kind));
  } catch (e) {
    setSetting(db, "backup_last_error", `${new Date().toISOString()} ${(e as Error).message}`);
    throw e;
  }
  const result: BackupResult = { file, size: statSync(file).size, pruned: pruneLocalBackups(settings.dir, settings.keep) };
  setSetting(db, "backup_last_at", String(Date.now()));
  setSetting(db, "backup_last_error", "");
  if (kind === "scheduled") setSetting(db, "backup_last_scheduled_at", String(Date.now()));

  if (settings.s3) {
    try {
      result.s3Key = await uploadToS3(settings.s3, file);
      await pruneS3Backups(settings.s3, settings.keep);
      setSetting(db, "backup_s3_last_at", String(Date.now()));
      setSetting(db, "backup_s3_last_error", "");
    } catch (e) {
      result.s3Error = describeS3Error(e, settings.s3);
      setSetting(db, "backup_s3_last_error", `${new Date().toISOString()} ${result.s3Error}`);
    }
  }
  return result;
}

export interface BackupStatus {
  lastAt: number | null;
  lastError: string | null;
  s3LastAt: number | null;
  s3LastError: string | null;
}

export function backupStatus(db: DB): BackupStatus {
  const num = (k: string) => {
    const v = getSetting(db, k);
    return v ? Number(v) : null;
  };
  return {
    lastAt: num("backup_last_at"),
    lastError: getSetting(db, "backup_last_error") || null,
    s3LastAt: num("backup_s3_last_at"),
    s3LastError: getSetting(db, "backup_s3_last_error") || null,
  };
}

/** Run scheduled backups from the server process. Returns a stop function. */
export function startBackupScheduler(db: DB, settings: BackupSettings, log: (msg: string) => void): () => void {
  if (settings.intervalHours <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    const last = Number(getSetting(db, "backup_last_scheduled_at") ?? 0);
    if (Date.now() - last < settings.intervalHours * 3600_000) return;
    running = true;
    try {
      const r = await createBackup(db, settings, "scheduled");
      log(`backup written to ${r.file} (${fmtBytes(r.size)})${r.s3Key ? `, uploaded to s3://${settings.s3!.bucket}/${r.s3Key}` : ""}`);
      if (r.s3Error) log(`WARNING: backup upload to S3 failed: ${r.s3Error}`);
    } catch (e) {
      log(`ERROR: backup failed: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, 30_000); // let startup (and any restore) settle first
  const timer = setInterval(tick, 10 * 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// ---------- restore ----------

const pendingPath = (dbPath: string) => `${resolve(dbPath)}.restore`;

/** Check that `file` is an intact tinyrss database this version can open. Returns its version. */
export function validateBackupFile(file: string): number {
  let db: Database;
  try {
    db = new Database(file, { readonly: true });
  } catch (e) {
    throw new Error(`cannot open ${file} as SQLite: ${(e as Error).message}`);
  }
  try {
    const integrity = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") throw new Error(`integrity check failed: ${integrity}`);
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    const hasFeeds = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feeds'").get();
    if (version < 1 || !hasFeeds) throw new Error("not a tinyrss database");
    if (version > SCHEMA_VERSION) {
      throw new Error(`backup has schema version ${version}, newer than this release supports (${SCHEMA_VERSION})`);
    }
    return version;
  } catch (e) {
    if ((e as Error).message.includes("file is not a database")) throw new Error(`${file} is not a SQLite database`);
    throw e;
  } finally {
    db.close();
  }
}

/**
 * Resolve a restore source: a path, the name of a local backup, or "s3:<name-or-key>".
 * Returns raw (possibly gzipped) bytes.
 */
async function readRestoreSource(source: string, settings: BackupSettings): Promise<{ bytes: Uint8Array<ArrayBuffer>; label: string }> {
  if (source.startsWith("s3:")) {
    if (!settings.s3) throw new Error("S3 backups are not configured (TINYRSS_BACKUP_S3_BUCKET)");
    let name = source.slice(3);
    if (name.startsWith("//")) {
      // full URL: s3://bucket/key
      const [bucket, ...rest] = name.slice(2).split("/");
      if (bucket !== settings.s3.bucket) throw new Error(`bucket "${bucket}" is not the configured bucket "${settings.s3.bucket}"`);
      name = rest.join("/");
    }
    if (!BACKUP_FILE_RE.test(name.split("/").pop() ?? "")) throw new Error(`"${source}" is not a tinyrss backup name`);
    const key = name.startsWith(settings.s3.prefix) ? name : settings.s3.prefix + name;
    const f = s3Client(settings.s3).file(key);
    let exists: boolean;
    try {
      exists = await f.exists();
      if (exists) return { bytes: await f.bytes(), label: `s3://${settings.s3.bucket}/${key}` };
    } catch (e) {
      throw new Error(`downloading from S3 failed: ${describeS3Error(e, settings.s3)}`);
    }
    throw new Error(`s3://${settings.s3.bucket}/${key} does not exist`);
  }
  for (const candidate of [source, join(settings.dir, source)]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { bytes: await Bun.file(candidate).bytes(), label: resolve(candidate) };
    }
  }
  throw new Error(`no backup found at "${source}" (or in ${settings.dir})`);
}

/**
 * Validate a backup and stage it as `<db>.restore`. The server swaps it in on its next start
 * (after snapshotting the current database), so restores never happen under a running server.
 */
export async function stageRestore(dbPath: string, source: string, settings: BackupSettings): Promise<{ label: string; version: number }> {
  const { bytes, label } = await readRestoreSource(source, settings);
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const raw = isGzip ? Bun.gunzipSync(bytes) : bytes;
  const tmp = `${pendingPath(dbPath)}.tmp`;
  await Bun.write(tmp, raw);
  try {
    const version = validateBackupFile(tmp);
    renameSync(tmp, pendingPath(dbPath));
    return { label, version };
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function hasPendingRestore(dbPath: string): boolean {
  return existsSync(pendingPath(dbPath));
}

export function cancelPendingRestore(dbPath: string): boolean {
  const p = pendingPath(dbPath);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

/**
 * If a restore is staged, snapshot the current database to a "pre-restore" backup and replace it.
 * Must run before the database is opened. Returns the pre-restore backup path (if any).
 */
export function applyPendingRestore(dbPath: string, settings: BackupSettings): { applied: boolean; previous?: string } {
  const pending = pendingPath(dbPath);
  if (!existsSync(pending)) return { applied: false };
  validateBackupFile(pending);
  const target = resolve(dbPath);
  let previous: string | undefined;
  if (existsSync(target)) {
    const current = new Database(target);
    try {
      previous = snapshotTo(current, newBackupPath(settings.dir, "pre-restore"));
      current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      current.close();
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(target + suffix, { force: true });
  renameSync(pending, target);
  pruneLocalBackups(settings.dir, settings.keep);
  return { applied: true, previous };
}

export type { BackupKind };
