/**
 * Google Reader ("GReader") compatible API, as implemented by FreshRSS/Miniflux/Inoreader
 * and consumed by clients such as Reeder, NetNewsWire, FeedMe, ReadKit, Fluent Reader, …
 */
import { Hono, type Context } from "hono";
import { checkToken, createToken, getUsername, postToken, verifyCredentials } from "./auth.ts";
import type { DB } from "./db.ts";
import { discoverFeed, fetchFeed } from "./fetcher.ts";
import { exportOpml, importOpml } from "./opml.ts";
import {
  addFeed,
  chunks,
  deleteFeed,
  deleteTag,
  ensureTag,
  feedDisplayTitle,
  findFeed,
  getItemsByIds,
  getTagByName,
  ITEM_SELECT,
  itemTagsFor,
  type ItemRow,
  listFeeds,
  listTags,
  renameTag,
  updateFeed,
} from "./store.ts";

const ITEM_PREFIX = "tag:google.com,2005:reader/item/";
const STATE = "user/-/state/com.google/";
const LABEL = "user/-/label/";
const S_READING_LIST = STATE + "reading-list";
const S_READ = STATE + "read";
const S_STARRED = STATE + "starred";
const S_KEPT_UNREAD = STATE + "kept-unread";

type Env = { Variables: { params: URLSearchParams; authToken: string } };

/** "user/1234/label/x" → "user/-/label/x" */
export function normalizeStreamId(s: string): string {
  return s.trim().replace(/^user\/[^/]+\//, "user/-/");
}

export function longItemId(id: number): string {
  return ITEM_PREFIX + id.toString(16).padStart(16, "0");
}

/** Accepts the long form, the decimal short form, or a bare 16-digit hex id. */
export function parseItemId(s: string): number | null {
  s = s.trim();
  let n: number;
  if (s.startsWith(ITEM_PREFIX)) n = parseInt(s.slice(ITEM_PREFIX.length), 16);
  else if (/^-?\d+$/.test(s)) n = Number(BigInt.asUintN(64, BigInt(s)));
  else if (/^[0-9a-f]{16}$/i.test(s)) n = parseInt(s, 16);
  else return null;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function readParams(c: Context): Promise<URLSearchParams> {
  const p = new URLSearchParams(new URL(c.req.url).search);
  if (c.req.method === "POST") {
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const fd = await c.req.formData();
      for (const [k, v] of fd.entries()) if (typeof v === "string") p.append(k, v);
    } else {
      const body = await c.req.text();
      if (body) for (const [k, v] of new URLSearchParams(body)) p.append(k, v);
    }
  }
  return p;
}

function intParam(p: URLSearchParams, name: string): number | undefined {
  const v = p.get(name);
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface Cond {
  sql: string;
  params: (string | number)[];
}

/** SQL condition (over `items i JOIN feeds f`) selecting the items of a stream. */
function streamCondition(db: DB, rawId: string): Cond {
  const id = normalizeStreamId(rawId);
  switch (id) {
    case S_READING_LIST:
      return { sql: "1", params: [] };
    case S_READ:
      return { sql: "i.read = 1", params: [] };
    case S_KEPT_UNREAD:
      return { sql: "i.read = 0", params: [] };
    case S_STARRED:
      return { sql: "i.starred = 1", params: [] };
  }
  if (id.startsWith(LABEL)) {
    const tag = getTagByName(db, id.slice(LABEL.length));
    if (!tag) return { sql: "0", params: [] };
    return {
      sql: "(f.tag_id = ? OR EXISTS (SELECT 1 FROM item_tags x WHERE x.item_id = i.id AND x.tag_id = ?))",
      params: [tag.id, tag.id],
    };
  }
  if (id.startsWith("feed/")) {
    const feed = findFeed(db, id);
    return feed ? { sql: "i.feed_id = ?", params: [feed.id] } : { sql: "0", params: [] };
  }
  return { sql: "0", params: [] };
}

interface StreamQuery {
  where: string;
  params: (string | number)[];
  order: "ASC" | "DESC";
  limit: number;
}

function buildStreamQuery(db: DB, streamId: string, p: URLSearchParams, maxN: number, defaultN: number): StreamQuery {
  const conds: Cond[] = [streamCondition(db, streamId)];
  for (const xt of p.getAll("xt")) {
    const c = streamCondition(db, xt);
    conds.push({ sql: `NOT ${c.sql}`, params: c.params });
  }
  for (const it of p.getAll("it")) conds.push(streamCondition(db, it));
  const ot = intParam(p, "ot"); // only items newer than (seconds)
  const nt = intParam(p, "nt"); // only items older than (seconds)
  if (ot !== undefined) conds.push({ sql: "i.crawled_us >= ?", params: [ot * 1_000_000] });
  if (nt !== undefined) conds.push({ sql: "i.crawled_us < ?", params: [nt * 1_000_000] });
  const order = p.get("r") === "o" ? "ASC" : "DESC";
  const cont = p.get("c");
  if (cont && /^\d+$/.test(cont)) conds.push({ sql: order === "ASC" ? "i.id >= ?" : "i.id <= ?", params: [Number(cont)] });
  const n = Math.max(1, Math.min(intParam(p, "n") ?? defaultN, maxN));
  return {
    where: conds.map((c) => c.sql).join(" AND "),
    params: conds.flatMap((c) => c.params),
    order,
    limit: n,
  };
}

function itemJson(row: ItemRow, labels: string[]) {
  const categories = [S_READING_LIST];
  if (row.read) categories.push(S_READ);
  if (row.starred) categories.push(S_STARRED);
  if (row.feed_tag) categories.push(LABEL + row.feed_tag);
  for (const l of labels) if (l !== row.feed_tag) categories.push(LABEL + l);
  const enclosures = row.enclosures ? (JSON.parse(row.enclosures) as { url: string; type?: string; length?: number }[]) : [];
  return {
    id: longItemId(row.id),
    crawlTimeMsec: String(Math.floor(row.crawled_us / 1000)),
    timestampUsec: String(row.crawled_us),
    published: row.published_at,
    updated: row.updated_at ?? row.published_at,
    title: row.title ?? "",
    author: row.author ?? undefined,
    canonical: row.url ? [{ href: row.url }] : [],
    alternate: row.url ? [{ href: row.url, type: "text/html" }] : [],
    categories,
    origin: {
      streamId: "feed/" + row.feed_url,
      title: row.feed_display_title,
      htmlUrl: row.feed_site_url ?? row.feed_url,
    },
    summary: { direction: "ltr", content: row.content ?? "" },
    enclosure: enclosures.length
      ? enclosures.map((e) => ({ href: e.url, type: e.type, length: e.length !== undefined ? String(e.length) : undefined }))
      : undefined,
  };
}

function itemsJson(db: DB, rows: ItemRow[]) {
  const labels = itemTagsFor(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => itemJson(r, labels.get(r.id) ?? []));
}

function streamTitle(db: DB, streamId: string): string {
  const id = normalizeStreamId(streamId);
  if (id.startsWith("feed/")) {
    const f = findFeed(db, id);
    return f ? feedDisplayTitle(f) : "";
  }
  if (id.startsWith(LABEL)) return id.slice(LABEL.length);
  if (id === S_STARRED) return "Starred items";
  return "Reading list";
}

function faviconFor(siteUrl: string | null, feedUrl: string): string | undefined {
  try {
    return new URL("/favicon.ico", siteUrl ?? feedUrl).toString();
  } catch {
    return undefined;
  }
}

function itemIdsFromParams(p: URLSearchParams): number[] {
  return p
    .getAll("i")
    .map(parseItemId)
    .filter((n): n is number => n !== null);
}

function applyItemTag(db: DB, ids: number[], tag: string, add: boolean) {
  const t = normalizeStreamId(tag);
  for (const chunk of chunks(ids, 500)) {
    const ph = chunk.map(() => "?").join(",");
    if (t === S_READ) db.query(`UPDATE items SET read = ? WHERE id IN (${ph})`).run(add ? 1 : 0, ...chunk);
    else if (t === S_KEPT_UNREAD) {
      if (add) db.query(`UPDATE items SET read = 0 WHERE id IN (${ph})`).run(...chunk);
    } else if (t === S_STARRED) db.query(`UPDATE items SET starred = ? WHERE id IN (${ph})`).run(add ? 1 : 0, ...chunk);
    else if (t.startsWith(LABEL)) {
      const name = t.slice(LABEL.length);
      if (add) {
        const tagId = ensureTag(db, name).id;
        const ins = db.query("INSERT OR IGNORE INTO item_tags (item_id, tag_id) SELECT id, ? FROM items WHERE id = ?");
        for (const id of chunk) ins.run(tagId, id);
      } else {
        const existing = getTagByName(db, name);
        if (existing) db.query(`DELETE FROM item_tags WHERE tag_id = ? AND item_id IN (${ph})`).run(existing.id, ...chunk);
      }
    }
    // other states (like, broadcast, tracking-*) are accepted and ignored
  }
}

const labelName = (s: string) => {
  const id = normalizeStreamId(s);
  return id.startsWith(LABEL) ? id.slice(LABEL.length) : id;
};

export function greaderApi(db: DB): Hono<Env> {
  const app = new Hono<Env>();
  // Note: middleware must be scoped to API paths, since this app is also mounted at "/".
  const withParams = async (c: Context<Env>, next: () => Promise<void>) => {
    c.set("params", await readParams(c));
    await next();
  };
  app.use("/accounts/*", withParams);

  // ----- authentication -----

  app.on(["GET", "POST"], "/accounts/ClientLogin", async (c) => {
    const p = c.get("params");
    const email = p.get("Email") ?? "";
    const passwd = p.get("Passwd") ?? "";
    if (!(await verifyCredentials(db, email, passwd))) {
      await Bun.sleep(1000); // slow down brute forcing
      return c.text("Error=BadAuthentication\n", 401);
    }
    const token = createToken(db, "api", c.req.header("user-agent")?.slice(0, 200));
    if (p.get("output") === "json") return c.json({ SID: token, LSID: null, Auth: token });
    return c.text(`SID=${token}\nLSID=null\nAuth=${token}\n`);
  });

  const api = new Hono<Env>();

  api.use("*", withParams);
  api.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.match(/^(?:GoogleLogin\s+auth=|Bearer\s+)(\S+)/i)?.[1];
    if (!token || !checkToken(db, "api", token)) {
      return c.text("Unauthorized", 401, { "Google-Bad-Token": "true" });
    }
    c.set("authToken", token);
    if (c.req.method === "POST") {
      // The action token is optional (auth is header-based so CSRF isn't a concern), but if a
      // client sends one it must be valid.
      const T = c.get("params").get("T");
      if (T && T !== postToken(db, token)) return c.text("Unauthorized", 401, { "X-Reader-Google-Bad-Token": "true" });
    }
    await next();
  });

  api.get("/token", (c) => c.text(postToken(db, c.get("authToken"))));

  api.get("/user-info", (c) => {
    const name = getUsername(db) ?? "user";
    return c.json({ userId: "1", userName: name, userProfileId: "1", userEmail: name, isBloggerUser: false, signupTimeSec: 0 });
  });

  api.get("/preference/list", (c) => c.json({ prefs: [] }));
  api.get("/preference/stream/list", (c) => c.json({ streamprefs: {} }));

  // ----- subscriptions & tags -----

  api.get("/subscription/list", (c) => {
    const subscriptions = listFeeds(db).map((f) => ({
      id: "feed/" + f.url,
      title: feedDisplayTitle(f),
      categories: f.tag_name ? [{ id: LABEL + f.tag_name, label: f.tag_name, type: "folder" }] : [],
      sortid: f.id.toString(16).padStart(8, "0").toUpperCase(),
      firstitemmsec: String(f.created_at),
      url: f.url,
      htmlUrl: f.site_url ?? f.url,
      iconUrl: faviconFor(f.site_url, f.url),
    }));
    return c.json({ subscriptions });
  });

  api.get("/subscription/export", (c) =>
    c.body(exportOpml(db), 200, {
      "Content-Type": "text/x-opml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="subscriptions.opml"',
    }),
  );

  api.post("/subscription/import", async (c) => {
    // Body may be raw OPML or a form field (Hono caches the body, so it can be read again).
    const raw = (await c.req.text()).trimStart();
    const xml = raw.startsWith("<") ? raw : (c.get("params").get("opml") ?? "");
    const res = importOpml(db, xml);
    return c.text(`OK ${res.added} added, ${res.skipped} skipped`);
  });

  api.get("/subscribed", (c) => {
    const s = c.get("params").get("s");
    return c.text(s && findFeed(db, s) ? "true" : "false");
  });

  api.post("/subscription/quickadd", async (c) => {
    const q = c.get("params").get("quickadd")?.replace(/^feed\//, "");
    if (!q) return c.json({ numResults: 0, error: "missing quickadd" }, 400);
    try {
      const { url } = await discoverFeed(q);
      const { feed, created } = addFeed(db, { url });
      if (created) await fetchFeed(db, feed.id);
      const fresh = findFeed(db, feed.url)!;
      return c.json({ numResults: 1, query: q, streamId: "feed/" + fresh.url, streamName: feedDisplayTitle(fresh) });
    } catch (e) {
      return c.json({ numResults: 0, query: q, error: (e as Error).message });
    }
  });

  api.post("/subscription/edit", async (c) => {
    const p = c.get("params");
    const ac = p.get("ac") ?? "edit";
    const streams = p.getAll("s");
    const titles = p.getAll("t");
    const add = p.get("a");
    const remove = p.get("r");
    if (!streams.length) return c.text("missing s", 400);

    if (ac === "subscribe") {
      for (const [idx, s] of streams.entries()) {
        const { feed, created } = addFeed(db, {
          url: s.replace(/^feed\//, ""),
          title: titles[idx] ?? null,
          tag: add ? labelName(add) : null,
        });
        if (created) await fetchFeed(db, feed.id);
      }
      return c.text("OK");
    }
    if (ac === "unsubscribe") {
      for (const s of streams) {
        const f = findFeed(db, s);
        if (f) deleteFeed(db, f.id);
      }
      return c.text("OK");
    }
    if (ac === "edit") {
      for (const [idx, s] of streams.entries()) {
        const f = findFeed(db, s);
        if (!f) return c.text(`unknown stream ${s}`, 404);
        const patch: Parameters<typeof updateFeed>[2] = {};
        if (titles[idx] !== undefined) patch.title = titles[idx];
        if (remove && f.tag_name?.toLowerCase() === labelName(remove).toLowerCase()) patch.tag = null;
        if (add) patch.tag = labelName(add);
        updateFeed(db, f.id, patch);
      }
      return c.text("OK");
    }
    return c.text(`unknown action ${ac}`, 400);
  });

  api.get("/tag/list", (c) => {
    const tags = [
      { id: S_STARRED },
      ...listTags(db).map((t) => ({ id: LABEL + t.name, type: t.feed_count > 0 ? "folder" : "tag" })),
    ];
    return c.json({ tags });
  });

  api.post("/rename-tag", (c) => {
    const p = c.get("params");
    const s = p.get("s");
    const dest = p.get("dest");
    if (!s || !dest) return c.text("missing s or dest", 400);
    renameTag(db, labelName(s), labelName(dest));
    return c.text("OK");
  });

  api.post("/disable-tag", (c) => {
    const s = c.get("params").get("s");
    if (!s) return c.text("missing s", 400);
    deleteTag(db, labelName(s));
    return c.text("OK");
  });

  // ----- counts -----

  api.get("/unread-count", (c) => {
    const rows = db
      .query("SELECT feed_id, COUNT(*) AS n, MAX(crawled_us) AS newest FROM items WHERE read = 0 GROUP BY feed_id")
      .all() as { feed_id: number; n: number; newest: number }[];
    const byFeed = new Map(rows.map((r) => [r.feed_id, r]));
    const unreadcounts: { id: string; count: number; newestItemTimestampUsec: string }[] = [];
    const byTag = new Map<string, { count: number; newest: number }>();
    let total = 0;
    let newestAll = 0;
    for (const f of listFeeds(db)) {
      const r = byFeed.get(f.id);
      const count = r?.n ?? 0;
      const newest = r?.newest ?? 0;
      unreadcounts.push({ id: "feed/" + f.url, count, newestItemTimestampUsec: String(newest) });
      if (f.tag_name) {
        const t = byTag.get(f.tag_name) ?? { count: 0, newest: 0 };
        t.count += count;
        t.newest = Math.max(t.newest, newest);
        byTag.set(f.tag_name, t);
      }
      total += count;
      newestAll = Math.max(newestAll, newest);
    }
    for (const [name, t] of byTag) {
      unreadcounts.push({ id: LABEL + name, count: t.count, newestItemTimestampUsec: String(t.newest) });
    }
    unreadcounts.push({ id: S_READING_LIST, count: total, newestItemTimestampUsec: String(newestAll) });
    return c.json({ max: total, unreadcounts });
  });

  // ----- streams -----

  const streamContents = (c: Context<Env>, streamId: string) => {
    const p = c.get("params");
    const q = buildStreamQuery(db, streamId, p, 1000, 20);
    const rows = db
      .query(`${ITEM_SELECT} WHERE ${q.where} ORDER BY i.id ${q.order} LIMIT ?`)
      .all(...q.params, q.limit + 1) as ItemRow[];
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    return c.json({
      direction: "ltr",
      id: streamId,
      title: streamTitle(db, streamId),
      updated: Math.floor(Date.now() / 1000),
      items: itemsJson(db, page),
      continuation: more ? String(rows[q.limit]!.id) : undefined,
    });
  };

  api.get("/stream/contents/*", (c) => {
    // Take the stream id from the raw path so encoded slashes/colons survive.
    const raw = new URL(c.req.url).pathname;
    const idx = raw.indexOf("/stream/contents/");
    let streamId = raw.slice(idx + "/stream/contents/".length);
    try {
      streamId = decodeURIComponent(streamId);
    } catch {
      // leave as-is
    }
    return streamContents(c, streamId || c.get("params").get("s") || S_READING_LIST);
  });
  api.get("/stream/contents", (c) => streamContents(c, c.get("params").get("s") ?? S_READING_LIST));

  api.get("/stream/items/ids", (c) => {
    const p = c.get("params");
    const streamId = p.get("s") ?? S_READING_LIST;
    const q = buildStreamQuery(db, streamId, p, 10000, 20);
    const rows = db
      .query(
        `SELECT i.id, i.crawled_us FROM items i JOIN feeds f ON f.id = i.feed_id
         WHERE ${q.where} ORDER BY i.id ${q.order} LIMIT ?`,
      )
      .all(...q.params, q.limit + 1) as { id: number; crawled_us: number }[];
    const more = rows.length > q.limit;
    const page = more ? rows.slice(0, q.limit) : rows;
    return c.json({
      itemRefs: page.map((r) => ({ id: String(r.id), directStreamIds: [], timestampUsec: String(r.crawled_us) })),
      continuation: more ? String(rows[q.limit]!.id) : undefined,
    });
  });

  api.get("/stream/items/count", (c) => {
    const p = c.get("params");
    const cond = streamCondition(db, p.get("s") ?? S_READING_LIST);
    const row = db.query(`SELECT COUNT(*) AS n FROM items i JOIN feeds f ON f.id = i.feed_id WHERE ${cond.sql}`).get(...cond.params) as {
      n: number;
    };
    return c.text(String(row.n));
  });

  api.on(["GET", "POST"], "/stream/items/contents", (c) => {
    const ids = itemIdsFromParams(c.get("params"));
    const rows = getItemsByIds(db, ids);
    return c.json({
      direction: "ltr",
      id: S_READING_LIST,
      title: "Reading list",
      updated: Math.floor(Date.now() / 1000),
      items: itemsJson(db, rows),
    });
  });

  // ----- state changes -----

  api.post("/edit-tag", (c) => {
    const p = c.get("params");
    const ids = itemIdsFromParams(p);
    db.transaction(() => {
      for (const t of p.getAll("r")) applyItemTag(db, ids, t, false);
      for (const t of p.getAll("a")) applyItemTag(db, ids, t, true);
    })();
    return c.text("OK");
  });

  api.post("/mark-all-as-read", (c) => {
    const p = c.get("params");
    const s = p.get("s");
    if (!s) return c.text("missing s", 400);
    const cond = streamCondition(db, s);
    const ts = intParam(p, "ts"); // microseconds
    const tsCond = ts !== undefined && ts > 0 ? " AND i.crawled_us <= ?" : "";
    db.query(
      `UPDATE items SET read = 1 WHERE id IN (
         SELECT i.id FROM items i JOIN feeds f ON f.id = i.feed_id WHERE i.read = 0 AND ${cond.sql}${tsCond})`,
    ).run(...cond.params, ...(tsCond ? [ts!] : []));
    return c.text("OK");
  });

  app.route("/reader/api/0", api);
  return app;
}
