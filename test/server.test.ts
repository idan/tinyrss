import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupSettings, createBackup, stageRestore } from "../src/backup.ts";
import { openDb } from "../src/db.ts";
import { serve } from "../src/server.ts";
import { addFeed } from "../src/store.ts";

const dir = mkdtempSync(join(tmpdir(), "tinyrss-server-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("rollback scenario: maintenance mode instead of crash-looping, recovers once a restore is staged", async () => {
  const dbPath = join(dir, "tinyrss.db");
  const settings = backupSettings(dbPath);

  // A database with a feed, and a backup of it.
  const db = openDb(dbPath);
  addFeed(db, { url: "https://kept.example/feed" });
  const { file } = await createBackup(db, settings, "manual");
  db.close();

  // A "newer release" upgraded the schema, then an older release was deployed.
  const raw = new Database(dbPath);
  raw.exec("PRAGMA user_version = 99");
  raw.close();

  const server = await serve({ dbPath, port: 0, hostname: "127.0.0.1" });
  const url = `http://127.0.0.1:${server.port}`;
  const health = await fetch(`${url}/healthz`);
  expect(health.status).toBe(503);
  const page = await (await fetch(`${url}/`)).text();
  expect(page).toContain("maintenance mode");
  expect(page).toContain("schema version 99");

  // Operator runs `tinyrss restore <name>` in the container shell…
  await stageRestore(dbPath, file.split("/").pop()!, settings);

  // …and the server comes back on its own (same port).
  let status = 0;
  for (let i = 0; i < 50 && status !== 200; i++) {
    await Bun.sleep(100);
    status = await fetch(`${url}/healthz`).then(
      (r) => r.status,
      () => 0,
    );
  }
  expect(status).toBe(200);
  const check = new Database(dbPath, { readonly: true });
  expect(check.query("SELECT url FROM feeds").values()).toEqual([["https://kept.example/feed"]]);
}, 15_000);
