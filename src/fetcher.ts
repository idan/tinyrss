import { config } from "./config.ts";
import type { DB } from "./db.ts";
import { discoverFeedLinks, NotAFeedError, parseFeed, type ParsedFeed } from "./parser.ts";
import { type FeedRow, getFeed, insertItems, normalizeFeedUrl, purgeOldItems } from "./store.ts";

const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_BACKOFF_MS = 24 * 3600_000;

async function httpGet(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    headers: {
      "User-Agent": config.userAgent,
      Accept: "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8",
      ...headers,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

async function readBody(res: Response): Promise<string> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) throw new Error(`response too large (${len} bytes)`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw new Error(`response too large (${buf.byteLength} bytes)`);
  // Honour an explicit charset; otherwise look at the XML declaration; default to UTF-8.
  let charset = res.headers.get("content-type")?.match(/charset=["']?([\w-]+)/i)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 200));
    charset = head.match(/<\?xml[^>]*encoding=["']([\w-]+)["']/i)?.[1];
  }
  try {
    return new TextDecoder((charset ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0]).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/**
 * Given a URL that is either a feed or a web page advertising one, return the feed URL
 * (and the parsed feed, to avoid fetching it twice).
 */
export async function discoverFeed(inputUrl: string): Promise<{ url: string; feed: ParsedFeed }> {
  const url = normalizeFeedUrl(inputUrl);
  const res = await httpGet(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const body = await readBody(res);
  try {
    return { url, feed: parseFeed(body, res.url || url) };
  } catch (e) {
    if (!(e instanceof NotAFeedError)) throw e;
  }
  for (const candidate of discoverFeedLinks(body, res.url || url)) {
    try {
      const r = await httpGet(candidate);
      if (!r.ok) continue;
      return { url: candidate, feed: parseFeed(await readBody(r), r.url || candidate) };
    } catch {
      // try the next one
    }
  }
  throw new NotAFeedError(`no feed found at ${url}`);
}

export interface FetchResult {
  feedId: number;
  status: "ok" | "not-modified" | "error";
  newItems: number;
  error?: string;
}

function nextFetch(errorCount: number): number {
  const base = config.fetchIntervalMinutes * 60_000;
  const delay = errorCount > 0 ? Math.min(base * 2 ** Math.min(errorCount, 10), MAX_BACKOFF_MS) : base;
  // jitter (±10%) so feeds imported together don't stay in lockstep
  return Date.now() + Math.round(delay * (0.9 + Math.random() * 0.2));
}

/** Store a parsed feed's metadata and items. */
export function storeParsedFeed(db: DB, feed: FeedRow, parsed: ParsedFeed): number {
  const cutoff = config.retentionDays > 0 ? Date.now() / 1000 - config.retentionDays * 86400 : -Infinity;
  // Feeds list newest first; insert oldest first so ids/crawl times follow publication order.
  const items = parsed.items
    .filter((i) => i.published === undefined || i.published >= cutoff)
    .sort((a, b) => (a.published ?? 0) - (b.published ?? 0));
  const seen = new Set<string>();
  const unique = items.filter((i) => !seen.has(i.guid) && seen.add(i.guid));
  const inserted = insertItems(db, feed.id, unique);
  db.query("UPDATE feeds SET feed_title = COALESCE(?, feed_title), site_url = COALESCE(?, site_url) WHERE id = ?").run(
    parsed.title ?? null,
    parsed.siteUrl ?? null,
    feed.id,
  );
  return inserted;
}

export async function fetchFeed(db: DB, feedId: number, opts: { force?: boolean } = {}): Promise<FetchResult> {
  const feed = getFeed(db, feedId);
  if (!feed) return { feedId, status: "error", newItems: 0, error: "feed not found" };
  const headers: Record<string, string> = {};
  if (!opts.force) {
    if (feed.etag) headers["If-None-Match"] = feed.etag;
    if (feed.last_modified) headers["If-Modified-Since"] = feed.last_modified;
  }
  try {
    const res = await httpGet(feed.url, headers);
    if (res.status === 304) {
      db.query("UPDATE feeds SET last_fetched_at = ?, next_fetch_at = ?, last_error = NULL, error_count = 0 WHERE id = ?").run(
        Date.now(),
        nextFetch(0),
        feed.id,
      );
      return { feedId, status: "not-modified", newItems: 0 };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    const parsed = parseFeed(await readBody(res), res.url || feed.url);
    const newItems = storeParsedFeed(db, feed, parsed);
    db.query(
      `UPDATE feeds SET etag = ?, last_modified = ?, last_fetched_at = ?, next_fetch_at = ?, last_error = NULL, error_count = 0
       WHERE id = ?`,
    ).run(res.headers.get("etag"), res.headers.get("last-modified"), Date.now(), nextFetch(0), feed.id);
    return { feedId, status: "ok", newItems };
  } catch (e) {
    const error = e instanceof Error ? (e.name === "TimeoutError" ? "request timed out" : e.message) : String(e);
    db.query("UPDATE feeds SET last_fetched_at = ?, next_fetch_at = ?, last_error = ?, error_count = error_count + 1 WHERE id = ?").run(
      Date.now(),
      nextFetch(feed.error_count + 1),
      error,
      feed.id,
    );
    return { feedId, status: "error", newItems: 0, error };
  }
}

async function runPool<T, R>(items: T[], concurrency: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function fetchFeeds(db: DB, ids: number[], opts: { force?: boolean } = {}): Promise<FetchResult[]> {
  return runPool(ids, config.fetchConcurrency, (id) => fetchFeed(db, id, opts));
}

export async function fetchDueFeeds(db: DB): Promise<FetchResult[]> {
  const ids = (db.query("SELECT id FROM feeds WHERE next_fetch_at <= ? ORDER BY next_fetch_at").all(Date.now()) as { id: number }[]).map(
    (r) => r.id,
  );
  return fetchFeeds(db, ids);
}

/** Periodically refresh due feeds and purge old items. Returns a stop function. */
export function startScheduler(db: DB, log: (msg: string) => void = console.log): () => void {
  let running = false;
  let lastPurge = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await fetchDueFeeds(db);
      const fresh = results.reduce((n, r) => n + r.newItems, 0);
      const errors = results.filter((r) => r.status === "error").length;
      if (results.length) log(`refreshed ${results.length} feed(s): ${fresh} new item(s), ${errors} error(s)`);
      if (Date.now() - lastPurge > 6 * 3600_000) {
        lastPurge = Date.now();
        const purged = purgeOldItems(db, config.retentionDays);
        if (purged) log(`purged ${purged} old item(s)`);
      }
    } catch (e) {
      log(`scheduler error: ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60_000);
  void tick();
  return () => clearInterval(timer);
}
