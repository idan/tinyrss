import type { Database } from "bun:sqlite";

export interface Migration {
  /** Short description, recorded for humans; the position in the list is the version number. */
  name: string;
  /** SQL to run, or a function for data transformations. Runs inside a transaction. */
  up: string | ((db: Database) => void);
  /**
   * Set for migrations that rebuild tables (SQLite's "create new table, copy, drop, rename"
   * pattern for changes ALTER TABLE can't do). Foreign key enforcement is switched off while the
   * migration runs and `PRAGMA foreign_key_check` must pass before it commits.
   */
  disableForeignKeys?: boolean;
}

/**
 * Schema migrations. Version N of the database = the first N migrations applied.
 *
 * RULES
 * - Only ever append. Never edit or reorder a migration that has been released: deployed
 *   databases already ran it. (test/migrations.test.ts enforces this via schema snapshots.)
 * - After adding one, run `bun run db:snapshot` and commit the new test/fixtures/db/vN.sql.
 * - Remember older app versions can't read newer schemas; the server refuses to start on a
 *   database that is newer than it knows (use the automatic pre-migration backup to roll back).
 */
export const migrations: Migration[] = [
  {
    name: "initial schema",
    up: `
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
  },
];

export const SCHEMA_VERSION = migrations.length;
