/**
 * Generate test/fixtures/db/v<N>.sql: a database at the current schema version filled with
 * representative data. Run after adding a migration and commit the file. Migration tests then
 * upgrade every committed version to the latest one and check the app still works with it.
 *
 *   bun run db:snapshot          # refuses to overwrite an existing (released) fixture
 *   bun run db:snapshot --force  # only while the migration is still unreleased
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToken, setCredentials } from "../src/auth.ts";
import { openDb } from "../src/db.ts";
import { SCHEMA_VERSION } from "../src/migrations.ts";
import { addFeed, ensureTag, insertItems } from "../src/store.ts";
import { dumpDb } from "../test/dbdump.ts";

export const FIXTURE_USER = "fixture";
export const FIXTURE_PASSWORD = "fixture-password";

const out = join(import.meta.dir, "..", "test", "fixtures", "db", `v${SCHEMA_VERSION}.sql`);
if (existsSync(out) && !process.argv.includes("--force")) {
  console.error(`${out} already exists. Released fixtures must not change; use --force only for unreleased migrations.`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "tinyrss-snapshot-"));
const db = openDb(join(dir, "fixture.db"));
await setCredentials(db, FIXTURE_USER, FIXTURE_PASSWORD);
createToken(db, "api", "fixture app");
createToken(db, "web", "fixture browser");

const t0 = 1_700_000_000; // fixed timestamps keep the fixture stable
const news = addFeed(db, { url: "https://news.example.com/rss", tag: "News" }).feed;
const blog = addFeed(db, { url: "https://blog.example.org/atom.xml", title: "My Blog (renamed)", tag: "Blogs" }).feed;
const loose = addFeed(db, { url: "https://loose.example.net/feed.json", feedTitle: "Loose ünïcödé feed" }).feed;
db.query("UPDATE feeds SET feed_title = ?, site_url = ?, etag = ?, last_modified = ?, last_fetched_at = ?, next_fetch_at = ? WHERE id = ?").run(
  "News Example",
  "https://news.example.com/",
  '"abc123"',
  "Tue, 14 Nov 2023 22:13:20 GMT",
  t0 * 1000,
  t0 * 1000 + 1_800_000,
  news.id,
);
db.query("UPDATE feeds SET last_error = ?, error_count = ? WHERE id = ?").run("HTTP 503 Service Unavailable", 3, loose.id);

for (const [feed, n] of [
  [news, 4],
  [blog, 3],
  [loose, 2],
] as const) {
  insertItems(
    db,
    feed.id,
    Array.from({ length: n }, (_, i) => ({
      guid: `${feed.url}#${i}`,
      url: i === 1 ? undefined : `${feed.url.replace(/\/[^/]*$/, "")}/post/${i}`,
      title: i === 2 ? undefined : `Post ${i} of ${feed.url} — “quotes” & <tags>`,
      author: i % 2 ? "Some Author" : undefined,
      content: `<p>Body ${i} with emoji 🎉 and 'quotes'</p>`,
      published: t0 - (n - i) * 3600,
      updated: i === 0 ? t0 : undefined,
      enclosures: i === 0 ? [{ url: "https://cdn.example.com/a.mp3", type: "audio/mpeg", length: 1234 }] : [],
    })),
  );
}
// normalize crawl times so the fixture doesn't depend on the clock
db.exec(`UPDATE items SET crawled_us = (${t0} * 1000000) + id`);
db.exec("UPDATE items SET read = 1 WHERE id IN (1, 2, 5)");
db.exec("UPDATE items SET starred = 1 WHERE id IN (2, 8)");
const later = ensureTag(db, "Later");
db.query("INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?), (?, ?)").run(3, later.id, 6, later.id);
db.query("UPDATE feeds SET created_at = ?").run(t0 * 1000);
db.query("UPDATE tokens SET created_at = ?, last_used_at = NULL").run(t0 * 1000);
db.query("UPDATE settings SET value = 'fixture-secret' WHERE key = 'secret'").run();

await Bun.write(out, dumpDb(db));
db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`Wrote ${out}`);
