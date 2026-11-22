import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { migrate, openDb, SchemaTooNewError, schemaVersion } from "../src/db.ts";
import { type Migration, migrations, SCHEMA_VERSION } from "../src/migrations.ts";
import { listLocalBackups } from "../src/backup.ts";
import { schemaOf } from "./dbdump.ts";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "db");
const FIXTURE_USER = "fixture";
const FIXTURE_PASSWORD = "fixture-password";

const tmp = mkdtempSync(join(tmpdir(), "tinyrss-migrations-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const tmpPath = (name = "db") => join(tmp, `${n++}-${name}`, "tinyrss.db");

const fixtures = readdirSync(FIXTURE_DIR)
  .map((f) => f.match(/^v(\d+)\.sql$/))
  .filter((m): m is RegExpMatchArray => m !== null)
  .map((m) => ({ version: Number(m[1]), file: join(FIXTURE_DIR, m[0]) }))
  .sort((a, b) => a.version - b.version);

/** Materialize a fixture as a database file (the way an old deployment's volume would look). */
async function fixtureDb(file: string): Promise<string> {
  const path = tmpPath("fixture");
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(await Bun.file(file).text());
  db.close();
  return path;
}

function counts(db: Database) {
  const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
  return {
    feeds: one("SELECT COUNT(*) AS n FROM feeds"),
    items: one("SELECT COUNT(*) AS n FROM items"),
    read: one("SELECT COUNT(*) AS n FROM items WHERE read = 1"),
    starred: one("SELECT COUNT(*) AS n FROM items WHERE starred = 1"),
    itemTags: one("SELECT COUNT(*) AS n FROM item_tags"),
    tokens: one("SELECT COUNT(*) AS n FROM tokens"),
  };
}

describe("schema fixtures", () => {
  test("a fixture exists for the current schema version", () => {
    // If this fails you added a migration: run `bun run db:snapshot` and commit the new file.
    expect(fixtures.map((f) => f.version)).toContain(SCHEMA_VERSION);
  });

  test("released migrations have not been modified", () => {
    // Each fixture records the schema produced by the first N migrations when it was released.
    // Editing an already-released migration would make fresh installs and upgraded installs diverge.
    for (const f of fixtures) {
      const fresh = new Database(":memory:");
      migrate(fresh, migrations.slice(0, f.version));
      const released = new Database(":memory:");
      released.exec(readFileSync(f.file, "utf8"));
      expect({ version: f.version, schema: schemaOf(fresh) }).toEqual({ version: f.version, schema: schemaOf(released) });
    }
  });
});

describe.each(fixtures)("upgrading a v$version database", ({ version, file }) => {
  test("migrates, keeps all data, and the app works with it", async () => {
    const path = await fixtureDb(file);
    const before = counts(new Database(path, { readonly: true }));
    const backupDir = join(path, "..", "backups");

    const db = openDb(path, { backupDir });
    expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(counts(db)).toEqual(before);

    // An upgrade (and only an upgrade) leaves a backup of the old version behind.
    const backups = listLocalBackups(backupDir);
    if (version < SCHEMA_VERSION) {
      expect(backups.map((b) => b.kind)).toEqual([`pre-migration-v${version}-to-v${SCHEMA_VERSION}`]);
      const old = new Database(join(backupDir, backups[0]!.name), { readonly: true });
      expect(schemaVersion(old)).toBe(version);
      expect(counts(old)).toEqual(before);
    } else {
      expect(backups).toEqual([]);
    }

    // Exercise the real API against the upgraded data.
    const app = createApp(db);
    const login = await app.request("/api/greader/accounts/ClientLogin", {
      method: "POST",
      body: new URLSearchParams({ Email: FIXTURE_USER, Passwd: FIXTURE_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const token = (await login.text()).match(/Auth=(\S+)/)![1]!;
    const get = async (p: string) => {
      const res = await app.request(`/api/greader/reader/api/0/${p}`, { headers: { Authorization: `GoogleLogin auth=${token}` } });
      expect(res.status).toBe(200);
      return (await res.json()) as any;
    };
    const subs = (await get("subscription/list")).subscriptions;
    expect(subs).toHaveLength(before.feeds);
    expect(subs.map((s: any) => s.title)).toContain("My Blog (renamed)");
    const unread = (await get("unread-count")).unreadcounts.find((c: any) => c.id === "user/-/state/com.google/reading-list");
    expect(unread.count).toBe(before.items - before.read);
    const all = await get("stream/contents/user%2F-%2Fstate%2Fcom.google%2Freading-list?n=1000");
    expect(all.items).toHaveLength(before.items);
    expect((await get("stream/contents/user%2F-%2Fstate%2Fcom.google%2Fstarred")).items).toHaveLength(before.starred);
    expect((await get("stream/contents/user%2F-%2Flabel%2FLater")).items).toHaveLength(before.itemTags);
    db.close();
  });
});

describe("migration runner", () => {
  const base: Migration[] = [
    {
      name: "parents and children",
      up: `CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);
           CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
           INSERT INTO parent VALUES (1, 'a'), (2, 'b');
           INSERT INTO child VALUES (10, 1), (11, 2);`,
    },
  ];
  const fileDb = (migs: Migration[]) => {
    const path = tmpPath();
    const db = openDb(path, { migrations: migs });
    db.close();
    return path;
  };

  test("fresh databases are not backed up", () => {
    const path = tmpPath();
    openDb(path, { migrations: base }).close();
    expect(existsSync(join(path, "..", "backups"))).toBe(false);
  });

  test("table rebuilds with foreign keys disabled keep dependent rows", () => {
    const path = fileDb(base);
    const rebuild: Migration = {
      name: "make parent.name NOT NULL",
      disableForeignKeys: true,
      up: `CREATE TABLE parent_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '');
           INSERT INTO parent_new SELECT id, COALESCE(name, '') FROM parent;
           DROP TABLE parent;
           ALTER TABLE parent_new RENAME TO parent;`,
    };
    const backups: string[] = [];
    const db = openDb(path, { migrations: [...base, rebuild], onBackup: (f) => backups.push(f) });
    expect(schemaVersion(db)).toBe(2);
    // Without disableForeignKeys, DROP TABLE parent would have cascaded and deleted the children.
    expect(db.query("SELECT COUNT(*) AS n FROM child").get()).toEqual({ n: 2 });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(backups).toHaveLength(1);
    expect(backups[0]).toContain("pre-migration-v1-to-v2");
  });

  test("on the real schema, rebuilding feeds needs disableForeignKeys or items are cascade-deleted", async () => {
    const latest = fixtures.at(-1)!;
    // A typical future migration: rebuild `feeds` (which `items` references ON DELETE CASCADE).
    const rebuildFeeds = (disableForeignKeys: boolean): Migration => ({
      name: "rebuild feeds",
      disableForeignKeys,
      up: (db) => {
        const { sql } = db.query("SELECT sql FROM sqlite_master WHERE name = 'feeds'").get() as { sql: string };
        db.exec(sql.replace(/^CREATE TABLE feeds/, "CREATE TABLE feeds_new"));
        db.exec("INSERT INTO feeds_new SELECT * FROM feeds; DROP TABLE feeds; ALTER TABLE feeds_new RENAME TO feeds;");
        db.exec("CREATE INDEX feeds_next_fetch ON feeds(next_fetch_at)");
      },
    });
    const itemsAfter = async (disable: boolean) => {
      const db = openDb(await fixtureDb(latest.file), { migrations: [...migrations, rebuildFeeds(disable)] });
      return (db.query("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
    };
    const original = counts(new Database(await fixtureDb(latest.file))).items;
    expect(original).toBeGreaterThan(0);
    expect(await itemsAfter(false)).toBe(0); // the trap
    expect(await itemsAfter(true)).toBe(original);
  });

  test("a migration leaving foreign key violations is rolled back", () => {
    const path = fileDb(base);
    const bad: Migration = {
      name: "orphan children",
      disableForeignKeys: true,
      up: "DELETE FROM parent WHERE id = 1",
    };
    expect(() => openDb(path, { migrations: [...base, bad] })).toThrow(/foreign key violation/);
    const db = new Database(path);
    expect(schemaVersion(db)).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM parent").get()).toEqual({ n: 2 });
  });

  test("a failing migration is rolled back; earlier ones in the same run are kept", () => {
    const path = fileDb(base);
    const ok: Migration = { name: "add column", up: "ALTER TABLE parent ADD COLUMN extra TEXT" };
    const failing: Migration = { name: "boom", up: "CREATE TABLE half_done (x); SELECT * FROM no_such_table;" };
    expect(() => openDb(path, { migrations: [...base, ok, failing] })).toThrow(/migration 3 \(boom\) failed/);
    const db = new Database(path);
    expect(schemaVersion(db)).toBe(2);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeNull();
    db.close();
    // fixing the migration and starting again picks up where it left off
    const fixed: Migration = { name: "boom (fixed)", up: "CREATE TABLE half_done (x)" };
    expect(schemaVersion(openDb(path, { migrations: [...base, ok, fixed] }))).toBe(3);
  });

  test("function migrations can transform data", () => {
    const path = fileDb(base);
    const upper: Migration = {
      name: "uppercase names",
      up: (db) => {
        for (const r of db.query("SELECT id, name FROM parent").all() as { id: number; name: string }[]) {
          db.query("UPDATE parent SET name = ? WHERE id = ?").run(r.name.toUpperCase(), r.id);
        }
      },
    };
    const db = openDb(path, { migrations: [...base, upper] });
    expect(db.query("SELECT name FROM parent ORDER BY id").values()).toEqual([["A"], ["B"]]);
  });

  test("refuses to open a database newer than the app (e.g. after a rollback)", () => {
    const extra: Migration = { name: "future", up: "CREATE TABLE future (x)" };
    const path = fileDb([...base, extra]);
    expect(() => openDb(path, { migrations: base })).toThrow(SchemaTooNewError);
    expect(() => openDb(path, { migrations: base })).toThrow(/pre-migration/);
    const db = new Database(path);
    expect(schemaVersion(db)).toBe(2);
  });
});
