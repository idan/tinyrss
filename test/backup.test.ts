import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { setCredentials } from "../src/auth.ts";
import {
  applyPendingRestore,
  type BackupSettings,
  backupSettings,
  createBackup,
  hasPendingRestore,
  listLocalBackups,
  listS3Backups,
  pruneLocalBackups,
  stageRestore,
} from "../src/backup.ts";
import { openDb } from "../src/db.ts";
import { backupFileName } from "../src/snapshot.ts";
import { addFeed } from "../src/store.ts";

const tmp = mkdtempSync(join(tmpdir(), "tinyrss-backup-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;

function setup(overrides: Partial<BackupSettings> = {}) {
  const dir = join(tmp, String(n++));
  const dbPath = join(dir, "tinyrss.db");
  const settings: BackupSettings = { dir: join(dir, "backups"), intervalHours: 24, keep: 3, s3: null, ...overrides };
  const db = openDb(dbPath, { backupDir: settings.dir });
  return { dir, dbPath, settings, db };
}

const feedUrls = (db: Database) => (db.query("SELECT url FROM feeds ORDER BY url").all() as { url: string }[]).map((r) => r.url);

test("backupSettings reads the environment", () => {
  const s = backupSettings("/data/tinyrss.db", {
    TINYRSS_BACKUP_KEEP: "5",
    TINYRSS_BACKUP_INTERVAL_HOURS: "6",
    TINYRSS_BACKUP_S3_BUCKET: "b",
    TINYRSS_BACKUP_S3_PREFIX: "rss",
    TINYRSS_BACKUP_S3_ENDPOINT: "https://s3.example.com",
  });
  expect(s).toMatchObject({ dir: "/data/backups", keep: 5, intervalHours: 6, s3: { bucket: "b", prefix: "rss/", endpoint: "https://s3.example.com" } });
  expect(backupSettings("/data/tinyrss.db", {}).s3).toBeNull();
});

test("createBackup writes a consistent, openable snapshot and records status", async () => {
  const { db, settings } = setup();
  addFeed(db, { url: "https://a.example/feed" });
  const r = await createBackup(db, settings, "manual");
  expect(r.file).toMatch(/tinyrss-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ-manual\.db$/);
  const copy = new Database(r.file, { readonly: true });
  expect(feedUrls(copy)).toEqual(["https://a.example/feed"]);
  expect(readdirSync(settings.dir).some((f) => f.endsWith(".partial"))).toBe(false);
});

test("rotation keeps N regular backups and safety backups separately", () => {
  const { settings } = setup();
  const day = (d: number) => new Date(Date.UTC(2024, 0, d));
  mkdirSync(settings.dir, { recursive: true });
  for (let d = 1; d <= 6; d++) writeFileSync(join(settings.dir, backupFileName(d % 2 ? "scheduled" : "manual", day(d))), "x");
  for (let d = 1; d <= 7; d++) writeFileSync(join(settings.dir, backupFileName(`pre-migration-v${d}-to-v${d + 1}`, day(d))), "x");
  writeFileSync(join(settings.dir, "unrelated.txt"), "x");
  pruneLocalBackups(settings.dir, 3);
  const left = listLocalBackups(settings.dir);
  expect(left.filter((b) => b.kind === "scheduled" || b.kind === "manual").map((b) => b.date.getUTCDate())).toEqual([6, 5, 4]);
  expect(left.filter((b) => b.kind.startsWith("pre-migration"))).toHaveLength(5);
  expect(readdirSync(settings.dir)).toContain("unrelated.txt");
});

describe("restore", () => {
  test("stage by name, apply on next start, keep the replaced database", async () => {
    const { db, dbPath, settings } = setup();
    addFeed(db, { url: "https://before.example/feed" });
    const backup = await createBackup(db, settings, "manual");
    addFeed(db, { url: "https://after.example/feed" });
    db.close();

    const name = backup.file.split("/").pop()!;
    expect(await stageRestore(dbPath, name, settings)).toMatchObject({ version: 1 });
    expect(hasPendingRestore(dbPath)).toBe(true);

    const res = applyPendingRestore(dbPath, settings);
    expect(res.applied).toBe(true);
    expect(hasPendingRestore(dbPath)).toBe(false);
    const restored = openDb(dbPath, { backupDir: settings.dir });
    expect(feedUrls(restored)).toEqual(["https://before.example/feed"]);
    // the database that was replaced is kept as a pre-restore backup
    expect(feedUrls(new Database(res.previous!, { readonly: true }))).toEqual([
      "https://after.example/feed",
      "https://before.example/feed",
    ]);
    expect(applyPendingRestore(dbPath, settings).applied).toBe(false);
  });

  test("accepts gzipped backups (as stored in S3)", async () => {
    const { db, dbPath, settings } = setup();
    addFeed(db, { url: "https://gz.example/feed" });
    const { file } = await createBackup(db, settings, "manual");
    const gz = join(tmp, `${n++}.db.gz`);
    await Bun.write(gz, Bun.gzipSync(await Bun.file(file).bytes()));
    db.query("DELETE FROM feeds").run();
    db.close();
    await stageRestore(dbPath, gz, settings);
    applyPendingRestore(dbPath, settings);
    expect(feedUrls(openDb(dbPath))).toEqual(["https://gz.example/feed"]);
  });

  test("rejects files that aren't usable tinyrss databases", async () => {
    const { dbPath, settings } = setup();
    const junk = join(tmp, `${n++}.db`);
    writeFileSync(junk, "definitely not sqlite ".repeat(100));
    await expect(stageRestore(dbPath, junk, settings)).rejects.toThrow(/not a SQLite database|cannot open/);

    const other = join(tmp, `${n++}.db`);
    new Database(other, { create: true }).exec("CREATE TABLE x (y); PRAGMA user_version = 1;");
    await expect(stageRestore(dbPath, other, settings)).rejects.toThrow(/not a tinyrss database/);

    const future = join(tmp, `${n++}.db`);
    new Database(future, { create: true }).exec("CREATE TABLE feeds (id); PRAGMA user_version = 999;");
    await expect(stageRestore(dbPath, future, settings)).rejects.toThrow(/newer than this release/);

    await expect(stageRestore(dbPath, "nope.db", settings)).rejects.toThrow(/no backup found/);
    expect(hasPendingRestore(dbPath)).toBe(false);
  });
});

test("web UI: backups section, back up now, download", async () => {
  const { db, dbPath, settings } = setup();
  await setCredentials(db, "me", "password123");
  const app = createApp(db, { dbPath, backups: settings });
  const H = "http://tinyrss.test";
  const login = await app.request(`${H}/login`, {
    method: "POST",
    body: new URLSearchParams({ username: "me", password: "password123" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;

  const make = await app.request(`${H}/backups`, { method: "POST", headers: { cookie, origin: H, host: "tinyrss.test" } });
  expect(new URL(make.headers.get("location")!, H).searchParams.get("msg")).toStartWith("Backup created");
  const [backup] = listLocalBackups(settings.dir);

  const home = await (await app.request(`${H}/`, { headers: { cookie } })).text();
  expect(home).toContain(backup!.name);
  expect(home).toContain("No off-site copy configured");

  const dl = await app.request(`${H}/backups/${backup!.name}`, { headers: { cookie } });
  expect(dl.status).toBe(200);
  expect(dl.headers.get("content-disposition")).toContain(backup!.name);
  expect((await dl.bytes()).length).toBe(backup!.size);

  expect((await app.request(`${H}/backups/..%2Ftinyrss.db`, { headers: { cookie } })).status).toBe(404);
  expect((await app.request(`${H}/backups/${backup!.name}`)).status).toBe(303); // requires login
});

// Runs only when an S3 endpoint is provided, e.g. a local MinIO:
//   TINYRSS_TEST_S3_ENDPOINT=http://127.0.0.1:9000 TINYRSS_TEST_S3_BUCKET=tinyrss-test \
//   TINYRSS_TEST_S3_ACCESS_KEY_ID=minioadmin TINYRSS_TEST_S3_SECRET_ACCESS_KEY=minioadmin bun test
const S3_ENDPOINT = process.env.TINYRSS_TEST_S3_ENDPOINT;
describe.skipIf(!S3_ENDPOINT)("S3 (integration)", () => {
  const s3 = {
    bucket: process.env.TINYRSS_TEST_S3_BUCKET ?? "tinyrss-test",
    prefix: `run-${Date.now()}/`,
    endpoint: S3_ENDPOINT,
    accessKeyId: process.env.TINYRSS_TEST_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.TINYRSS_TEST_S3_SECRET_ACCESS_KEY,
  };

  test("upload, rotate, and restore from S3", async () => {
    const { db, dbPath, settings } = setup({ keep: 2, s3 });
    addFeed(db, { url: "https://s3.example/feed" });
    for (let i = 0; i < 3; i++) {
      const r = await createBackup(db, settings, "manual");
      expect(r.s3Error).toBeUndefined();
      expect(r.s3Key).toMatch(/\.db\.gz$/);
    }
    const remote = await listS3Backups(s3);
    expect(remote).toHaveLength(2);

    db.query("DELETE FROM feeds").run();
    db.close();
    await expect(stageRestore(dbPath, `s3://${s3.bucket}/${s3.prefix}`, settings)).rejects.toThrow(/not a tinyrss backup/);
    await expect(stageRestore(dbPath, `s3://other-bucket/${remote[0]!.name}`, settings)).rejects.toThrow(/not the configured bucket/);
    await stageRestore(dbPath, `s3://${s3.bucket}/${s3.prefix}${remote[0]!.name}`, settings); // full URL
    await stageRestore(dbPath, `s3:${remote[0]!.name}`, settings); // short form
    applyPendingRestore(dbPath, settings);
    expect(feedUrls(openDb(dbPath))).toEqual(["https://s3.example/feed"]);
  });

  test("S3 failures don't fail the local backup", async () => {
    const { db, settings } = setup({ s3: { ...s3, secretAccessKey: "wrong" } });
    const r = await createBackup(db, settings, "manual");
    expect(r.file).toBeTruthy();
    expect(r.s3Error).toBeTruthy();
  });
});
