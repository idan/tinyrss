import type { DB } from "./db.ts";
import type { Enclosure } from "./parser.ts";

export interface FeedRow {
  id: number;
  url: string;
  title: string | null;
  feed_title: string | null;
  site_url: string | null;
  tag_id: number | null;
  tag_name: string | null;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: number | null;
  next_fetch_at: number;
  last_error: string | null;
  error_count: number;
  created_at: number;
}

export interface TagRow {
  id: number;
  name: string;
}

export interface ItemRow {
  id: number;
  feed_id: number;
  guid: string;
  url: string | null;
  title: string | null;
  author: string | null;
  content: string | null;
  enclosures: string | null;
  published_at: number;
  updated_at: number | null;
  crawled_us: number;
  read: number;
  starred: number;
  feed_url: string;
  feed_display_title: string;
  feed_site_url: string | null;
  feed_tag: string | null;
}

export function feedDisplayTitle(f: Pick<FeedRow, "title" | "feed_title" | "url">): string {
  return f.title || f.feed_title || f.url;
}

const FEED_SELECT = `SELECT f.*, t.name AS tag_name FROM feeds f LEFT JOIN tags t ON t.id = f.tag_id`;

// ---------- tags ----------

export function listTags(db: DB): (TagRow & { feed_count: number; item_count: number })[] {
  return db
    .query(
      `SELECT t.id, t.name,
        (SELECT COUNT(*) FROM feeds f WHERE f.tag_id = t.id) AS feed_count,
        (SELECT COUNT(*) FROM item_tags it WHERE it.tag_id = t.id) AS item_count
       FROM tags t ORDER BY t.name COLLATE NOCASE`,
    )
    .all() as any;
}

export function getTagByName(db: DB, name: string): TagRow | null {
  return db.query("SELECT id, name FROM tags WHERE name = ?").get(name) as TagRow | null;
}

export function ensureTag(db: DB, name: string): TagRow {
  name = name.trim();
  if (!name) throw new Error("tag name must not be empty");
  if (name.includes("/")) throw new Error("tag name must not contain '/'");
  const existing = getTagByName(db, name);
  if (existing) return existing;
  const id = Number(db.query("INSERT INTO tags (name) VALUES (?)").run(name).lastInsertRowid);
  return { id, name };
}

/** Rename a tag. If the destination exists, the tags are merged. */
export function renameTag(db: DB, from: string, to: string): boolean {
  const src = getTagByName(db, from);
  if (!src) return false;
  to = to.trim();
  if (!to) throw new Error("tag name must not be empty");
  db.transaction(() => {
    const dest = getTagByName(db, to);
    if (dest && dest.id !== src.id) {
      db.query("UPDATE feeds SET tag_id = ? WHERE tag_id = ?").run(dest.id, src.id);
      db.query("INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT item_id, ? FROM item_tags WHERE tag_id = ?").run(
        dest.id,
        src.id,
      );
      db.query("DELETE FROM tags WHERE id = ?").run(src.id);
    } else {
      db.query("UPDATE tags SET name = ? WHERE id = ?").run(to, src.id);
    }
  })();
  return true;
}

export function deleteTag(db: DB, name: string): boolean {
  return db.query("DELETE FROM tags WHERE name = ?").run(name).changes > 0;
}

function pruneUnusedTags(db: DB) {
  db.query(
    `DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM feeds WHERE tag_id = tags.id)
       AND NOT EXISTS (SELECT 1 FROM item_tags WHERE tag_id = tags.id)`,
  ).run();
}

// ---------- feeds ----------

export function listFeeds(db: DB): (FeedRow & { unread: number; total: number })[] {
  return db
    .query(
      `SELECT f.*, t.name AS tag_name,
        (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND i.read = 0) AS unread,
        (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id) AS total
       FROM feeds f LEFT JOIN tags t ON t.id = f.tag_id
       ORDER BY t.name IS NULL, t.name COLLATE NOCASE, COALESCE(f.title, f.feed_title, f.url) COLLATE NOCASE`,
    )
    .all() as any;
}

export function getFeed(db: DB, id: number): FeedRow | null {
  return db.query(`${FEED_SELECT} WHERE f.id = ?`).get(id) as FeedRow | null;
}

export function getFeedByUrl(db: DB, url: string): FeedRow | null {
  return db.query(`${FEED_SELECT} WHERE f.url = ?`).get(url) as FeedRow | null;
}

/** Resolve a GReader feed reference ("feed/<url>", "feed/<id>", a URL or an id). */
export function findFeed(db: DB, ref: string): FeedRow | null {
  const r = ref.startsWith("feed/") ? ref.slice(5) : ref;
  return getFeedByUrl(db, r) ?? (/^\d+$/.test(r) ? getFeed(db, Number(r)) : null);
}

export function normalizeFeedUrl(url: string): string {
  url = url.trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = "https://" + url;
  const u = new URL(url);
  if (u.protocol === "feed:") return normalizeFeedUrl(url.slice(5).replace(/^\/\//, ""));
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`unsupported URL scheme: ${u.protocol}`);
  return u.toString();
}

export function addFeed(
  db: DB,
  opts: { url: string; title?: string | null; feedTitle?: string | null; tag?: string | null },
): { feed: FeedRow; created: boolean } {
  const url = normalizeFeedUrl(opts.url);
  const existing = getFeedByUrl(db, url);
  if (existing) return { feed: existing, created: false };
  const tagId = opts.tag?.trim() ? ensureTag(db, opts.tag).id : null;
  const id = Number(
    db
      .query("INSERT INTO feeds (url, title, feed_title, tag_id, created_at, next_fetch_at) VALUES (?, ?, ?, ?, ?, 0)")
      .run(url, opts.title?.trim() || null, opts.feedTitle?.trim() || null, tagId, Date.now()).lastInsertRowid,
  );
  return { feed: getFeed(db, id)!, created: true };
}

export function updateFeed(db: DB, id: number, patch: { url?: string; title?: string | null; tag?: string | null }) {
  db.transaction(() => {
    if (patch.url !== undefined) {
      const url = normalizeFeedUrl(patch.url);
      const other = getFeedByUrl(db, url);
      if (other && other.id !== id) throw new Error("another subscription already uses this URL");
      db.query("UPDATE feeds SET url = ?, etag = NULL, last_modified = NULL, next_fetch_at = 0 WHERE id = ? AND url != ?").run(
        url,
        id,
        url,
      );
    }
    if (patch.title !== undefined) db.query("UPDATE feeds SET title = ? WHERE id = ?").run(patch.title?.trim() || null, id);
    if (patch.tag !== undefined) {
      const tagId = patch.tag?.trim() ? ensureTag(db, patch.tag).id : null;
      db.query("UPDATE feeds SET tag_id = ? WHERE id = ?").run(tagId, id);
    }
    pruneUnusedTags(db);
  })();
}

export function deleteFeed(db: DB, id: number): boolean {
  const changed = db.query("DELETE FROM feeds WHERE id = ?").run(id).changes > 0;
  pruneUnusedTags(db);
  return changed;
}

// ---------- items ----------

let lastCrawlUs = 0;
/** Monotonic, unique microsecond timestamp used as the GReader crawl time. */
function nextCrawlUs(db: DB): number {
  if (lastCrawlUs === 0) {
    const row = db.query("SELECT MAX(crawled_us) AS m FROM items").get() as { m: number | null };
    lastCrawlUs = row.m ?? 0;
  }
  lastCrawlUs = Math.max(lastCrawlUs + 1, Date.now() * 1000);
  return lastCrawlUs;
}

export interface NewItem {
  guid: string;
  url?: string;
  title?: string;
  author?: string;
  content?: string;
  published?: number;
  updated?: number;
  enclosures: Enclosure[];
}

/** Insert items (given oldest first), ignoring ones already known. Returns number inserted. */
export function insertItems(db: DB, feedId: number, items: NewItem[]): number {
  const insert = db.query(
    `INSERT INTO items (feed_id, guid, url, title, author, content, enclosures, published_at, updated_at, crawled_us)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (feed_id, guid) DO UPDATE SET
       url = excluded.url, title = excluded.title, author = excluded.author, content = excluded.content,
       enclosures = excluded.enclosures, updated_at = excluded.updated_at
     WHERE excluded.updated_at IS NOT NULL AND excluded.updated_at > COALESCE(items.updated_at, 0)`,
  );
  const exists = db.query("SELECT 1 FROM items WHERE feed_id = ? AND guid = ?");
  let inserted = 0;
  const nowSec = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    for (const it of items) {
      const isNew = !exists.get(feedId, it.guid);
      // Clamp bogus future dates so they don't stick to the top forever.
      const published = Math.min(it.published ?? nowSec, nowSec);
      insert.run(
        feedId,
        it.guid,
        it.url ?? null,
        it.title ?? null,
        it.author ?? null,
        it.content ?? null,
        it.enclosures.length ? JSON.stringify(it.enclosures) : null,
        published,
        it.updated ?? null,
        isNew ? nextCrawlUs(db) : 0,
      );
      if (isNew) inserted++;
    }
  })();
  return inserted;
}

/** Delete read, unstarred, unlabelled items older than `days`. */
export function purgeOldItems(db: DB, days: number): number {
  if (days <= 0) return 0;
  const cutoffUs = (Date.now() - days * 86_400_000) * 1000;
  return db
    .query(
      `DELETE FROM items WHERE read = 1 AND starred = 0 AND crawled_us < ?
         AND NOT EXISTS (SELECT 1 FROM item_tags WHERE item_id = items.id)`,
    )
    .run(cutoffUs).changes;
}

export function itemTagsFor(db: DB, itemIds: number[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const chunk of chunks(itemIds, 500)) {
    const rows = db
      .query(
        `SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id
         WHERE it.item_id IN (${chunk.map(() => "?").join(",")})`,
      )
      .all(...chunk) as { item_id: number; name: string }[];
    for (const r of rows) {
      const list = out.get(r.item_id) ?? [];
      list.push(r.name);
      out.set(r.item_id, list);
    }
  }
  return out;
}

export const ITEM_SELECT = `
  SELECT i.*, f.url AS feed_url, COALESCE(f.title, f.feed_title, f.url) AS feed_display_title,
         f.site_url AS feed_site_url, t.name AS feed_tag
  FROM items i JOIN feeds f ON f.id = i.feed_id LEFT JOIN tags t ON t.id = f.tag_id`;

export function getItemsByIds(db: DB, ids: number[]): ItemRow[] {
  const out: ItemRow[] = [];
  for (const chunk of chunks(ids, 500)) {
    out.push(...(db.query(`${ITEM_SELECT} WHERE i.id IN (${chunk.map(() => "?").join(",")})`).all(...chunk) as ItemRow[]));
  }
  const order = new Map(ids.map((id, idx) => [id, idx]));
  return out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
}

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
