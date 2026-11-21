import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database;

const migrations: string[] = [
  // 1: initial schema
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- API (GReader) and web session tokens. Only a hash of the token is stored.
  CREATE TABLE tokens (
    hash         TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('api', 'web')),
    label        TEXT,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
  );

  -- Tags are shared between folders (applied to feeds) and labels (applied to items),
  -- exactly like in Google Reader.
  CREATE TABLE tags (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  CREATE TABLE feeds (
    id              INTEGER PRIMARY KEY,
    url             TEXT NOT NULL UNIQUE,
    title           TEXT,             -- user override
    feed_title      TEXT,             -- title advertised by the feed
    site_url        TEXT,
    tag_id          INTEGER REFERENCES tags(id) ON DELETE SET NULL,
    etag            TEXT,
    last_modified   TEXT,
    last_fetched_at INTEGER,          -- unix ms
    next_fetch_at   INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    error_count     INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX feeds_next_fetch ON feeds(next_fetch_at);

  CREATE TABLE items (
    id           INTEGER PRIMARY KEY,
    feed_id      INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid         TEXT NOT NULL,
    url          TEXT,
    title        TEXT,
    author       TEXT,
    content      TEXT,
    enclosures   TEXT,                -- JSON array
    published_at INTEGER NOT NULL,    -- unix seconds
    updated_at   INTEGER,             -- unix seconds
    crawled_us   INTEGER NOT NULL,    -- unix microseconds, unique & monotonic
    read         INTEGER NOT NULL DEFAULT 0,
    starred      INTEGER NOT NULL DEFAULT 0,
    UNIQUE (feed_id, guid)
  );
  CREATE INDEX items_feed ON items(feed_id, id);
  CREATE INDEX items_unread ON items(read, feed_id);
  CREATE INDEX items_starred ON items(starred) WHERE starred = 1;
  CREATE INDEX items_crawled ON items(crawled_us);

  CREATE TABLE item_tags (
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
  ) WITHOUT ROWID;
  CREATE INDEX item_tags_tag ON item_tags(tag_id);
  `,
];

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const { user_version } = db.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
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
