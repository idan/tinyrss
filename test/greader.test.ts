import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import Reader, { ApiError, States } from "libseymour";
import { createApp } from "../src/app.ts";
import { setCredentials } from "../src/auth.ts";
import { openDb } from "../src/db.ts";
import { startFixtureServer } from "./fixtures.ts";

const USER = "me@example.com";
const PASS = "correct horse battery";

const fixtures = startFixtureServer();
const db = openDb(":memory:");
await setCredentials(db, USER, PASS);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createApp(db).fetch });
const base = `http://127.0.0.1:${server.port}`;
const BASE = `${base}/api/greader`;

const RSS = fixtures.url("/rss.xml");
const ATOM = fixtures.url("/atom.xml");

// libseymour's typings are stricter than real-world responses (extra fields etc.), so keep tests loose.
let api: any;
let token: string;

/** Raw authenticated API call, for things libseymour doesn't expose (e.g. continuation). */
async function raw(path: string, init: RequestInit = {}) {
  return fetch(`${BASE}/reader/api/0/${path}`, {
    ...init,
    headers: { Authorization: `GoogleLogin auth=${token}`, ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  api = new Reader({ url: BASE, client: "tinyrss-test" });
  token = await api.getAuthToken(USER, PASS);
});

afterAll(() => {
  server.stop(true);
  fixtures.server.stop(true);
});

describe("authentication", () => {
  test("rejects bad credentials", async () => {
    const r = new Reader({ url: BASE });
    const err = await r.getAuthToken(USER, "wrong password").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  }, 5000);

  test("rejects unauthenticated API calls", async () => {
    const r = new Reader({ url: BASE });
    r.setAuthToken("bogus");
    const err = await r.getUserInfo().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
  });

  test("username is case-insensitive and API also works at host root", async () => {
    const r = new Reader({ url: base });
    await r.getAuthToken(USER.toUpperCase(), PASS);
    expect((await r.getUserInfo()).userName).toBe(USER);
  });

  test("user info and post token", async () => {
    const info = await api.getUserInfo();
    expect(info.userName).toBe(USER);
    const T = await api.getPostToken();
    expect(T).toHaveLength(57);
  });

  test("rejects an invalid post token", async () => {
    const res = await raw("edit-tag", { method: "POST", body: new URLSearchParams({ T: "nope", i: "1", a: States.READ }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Reader-Google-Bad-Token")).toBe("true");
  });
});

describe("subscriptions", () => {
  test("subscribe fetches the feed", async () => {
    await api.addFeed({ url: RSS, title: "My RSS", tag: "News" });
    await api.addFeed(ATOM);
    const feeds = await api.getFeeds();
    expect(feeds).toHaveLength(2);
    const rss = feeds.find((f: any) => f.url === RSS)!;
    expect(rss.id).toBe(`feed/${RSS}`);
    expect(rss.title).toBe("My RSS");
    expect(rss.htmlUrl).toBe("https://example.com/");
    expect(rss.categories).toEqual([{ id: "user/-/label/News", label: "News", type: "folder" }]);
    const atom = feeds.find((f: any) => f.url === ATOM)!;
    expect(atom.title).toBe("Example Atom");
    expect(atom.categories).toEqual([]);
  });

  test("tags", async () => {
    const tags = await api.getTags();
    expect(tags.map((t: any) => t.id)).toEqual(["user/-/state/com.google/starred", "user/-/label/News"]);
  });

  test("rename feed, move between folders", async () => {
    await api.renameFeed({ id: ATOM, title: "Renamed Atom" });
    await api.addFeedTag(ATOM, "Blogs");
    let atom = (await api.getFeeds()).find((f: any) => f.url === ATOM)!;
    expect(atom.title).toBe("Renamed Atom");
    expect(atom.categories[0].label).toBe("Blogs");
    await api.removeFeedTag(ATOM, "Blogs");
    atom = (await api.getFeeds()).find((f: any) => f.url === ATOM)!;
    expect(atom.categories).toEqual([]);
    // unused folder is pruned
    expect((await api.getTags()).map((t: any) => t.id)).not.toContain("user/-/label/Blogs");
    await api.addFeedTag(ATOM, "Blogs");
  });

  test("quickadd discovers feeds from a web page", async () => {
    const res = await raw("subscription/quickadd", { method: "POST", body: new URLSearchParams({ quickadd: fixtures.url("/blog") }) });
    const json = await res.json();
    // already subscribed to the discovered atom feed
    expect(json).toMatchObject({ numResults: 1, streamId: `feed/${ATOM}` });
  });

  test("OPML export", async () => {
    const res = await raw("subscription/export");
    const text = await res.text();
    expect(text).toContain(`xmlUrl="${RSS}"`);
    expect(text).toContain(`<outline text="News"`);
  });
});

describe("items", () => {
  test("reading list contains all items, newest first", async () => {
    const items = await api.getItems(States.ALL, { num: 100 });
    expect(items).toHaveLength(6);
    const ts = items.map((i: any) => i.timestampUsec);
    expect([...ts].sort((a, b) => b - a)).toEqual(ts);
    const one = items.find((i: any) => i.title === "RSS item 1 & more")!;
    expect(one.id).toMatch(/^tag:google\.com,2005:reader\/item\/[0-9a-f]{16}$/);
    expect(one.summary.content).toBe("<p>Full <b>content</b> 1</p>");
    expect(one.origin).toEqual({ streamId: `feed/${RSS}`, title: "My RSS", htmlUrl: "https://example.com/" });
    expect(one.canonical[0].href).toBe("https://example.com/rss/1");
    expect(one.author).toBe("Author 1");
    expect(one.categories).toContain("user/-/state/com.google/reading-list");
    expect(one.categories).toContain("user/-/label/News");
    expect(one.categories).not.toContain(States.READ);
    const ep = items.find((i: any) => i.title === "RSS item 2 & more")!;
    expect(ep.enclosure).toEqual([{ href: "https://example.com/ep2.mp3", type: "audio/mpeg", length: "1234" }]);
  });

  test("feed and label streams", async () => {
    expect(await api.getItems(RSS)).toHaveLength(3);
    expect(await api.getItems("user/-/label/News")).toHaveLength(3);
    expect(await api.getItems("user/-/label/Blogs")).toHaveLength(3);
    expect(await api.getItems("user/-/label/Nope")).toHaveLength(0);
  });

  test("oldest-first ordering", async () => {
    const items = await api.getItems(RSS, { sort: "asc" });
    expect(items.map((i: any) => i.title)).toEqual(["RSS item 3 & more", "RSS item 2 & more", "RSS item 1 & more"]);
  });

  test("item ids and contents by id (short and long form)", async () => {
    const ids = await api.getItemIds(States.ALL, { num: 100 });
    expect(ids).toHaveLength(6);
    expect(ids.every((id: string) => /^\d+$/.test(id))).toBe(true);
    const byShort = await api.getItemsById(ids.slice(0, 2));
    expect(byShort).toHaveLength(2);
    const byLong = await api.getItemsById(byShort.map((i: any) => i.id));
    expect(byLong.map((i: any) => i.id)).toEqual(byShort.map((i: any) => i.id));
  });

  test("pagination with continuation", async () => {
    const seen: string[] = [];
    let c: string | undefined;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ n: "4", output: "json", ...(c ? { c } : {}) });
      const res = await raw(`stream/contents/${encodeURIComponent(States.ALL)}?${qs}`);
      const json = (await res.json()) as any;
      seen.push(...json.items.map((i: any) => i.id));
      c = json.continuation;
      pages++;
    } while (c);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(6);

    const idsPage = (await (await raw(`stream/items/ids?s=${States.ALL}&n=5`)).json()) as any;
    expect(idsPage.itemRefs).toHaveLength(5);
    expect(idsPage.continuation).toBeDefined();
  });

  test("unread counts", async () => {
    const counts = await api.getUnreadCounts();
    const byId = Object.fromEntries(counts.map((c: any) => [c.id, c.count]));
    expect(byId).toEqual({
      [`feed/${RSS}`]: 3,
      [`feed/${ATOM}`]: 3,
      "user/-/label/News": 3,
      "user/-/label/Blogs": 3,
      [States.ALL]: 6,
    });
  });

  test("mark read / unread and exclude read", async () => {
    const [first, second] = await api.getItems(RSS);
    await api.addItemTag([first.id, second.id], States.READ);
    const unread = await api.getItems(RSS, { exclude: States.READ });
    expect(unread).toHaveLength(1);
    expect((await api.getItemIds(States.READ)).length).toBe(2);
    await api.removeItemTag(second.id, States.READ);
    expect(await api.getItems(RSS, { exclude: States.READ })).toHaveLength(2);
    const [item] = await api.getItemsById(first.id);
    expect(item.categories).toContain(States.READ);
  });

  test("star / unstar", async () => {
    const [item] = await api.getItems(ATOM);
    await api.addItemTag(item.id, States.STARRED);
    const starred = await api.getItems(States.STARRED);
    expect(starred.map((i: any) => i.id)).toEqual([item.id]);
    expect(starred[0].categories).toContain(States.STARRED);
    await api.removeItemTag(item.id, States.STARRED);
    expect(await api.getItems(States.STARRED)).toHaveLength(0);
  });

  test("item labels", async () => {
    const [item] = await api.getItems(RSS);
    await api.addItemTag(item.id, "user/-/label/Later");
    const later = await api.getItems("user/-/label/Later");
    expect(later.map((i: any) => i.id)).toEqual([item.id]);
    expect(later[0].categories).toContain("user/-/label/Later");
    const tags = await api.getTags();
    expect(tags).toContainEqual({ id: "user/-/label/Later", type: "tag" });
    await api.removeItemTag(item.id, "user/-/label/Later");
    expect(await api.getItems("user/-/label/Later")).toHaveLength(0);
  });

  test("time filters (ot / nt)", async () => {
    const future = Math.floor(Date.now() / 1000) + 60;
    expect(await api.getItems(States.ALL, { sMin: future })).toHaveLength(0);
    expect(await api.getItems(States.ALL, { sMax: future })).toHaveLength(6);
  });

  test("new items appear after refresh, old ones aren't duplicated", async () => {
    const { fetchFeeds } = await import("../src/fetcher.ts");
    const { listFeeds } = await import("../src/store.ts");
    fixtures.state.rssCount = 5;
    await fetchFeeds(
      db,
      listFeeds(db).map((f) => f.id),
    );
    expect(await api.getItems(RSS, { num: 50 })).toHaveLength(5);
  });

  test("mark all as read, with timestamp limit", async () => {
    const items = await api.getItems(RSS, { num: 50, sort: "asc" });
    // only items crawled up to and including the 3rd one
    await api.setAllRead(`feed/${RSS}`, items[2].timestampUsec);
    expect(await api.getItems(RSS, { exclude: States.READ })).toHaveLength(2);
    await api.setAllRead("user/-/label/News");
    expect(await api.getItems(RSS, { exclude: States.READ })).toHaveLength(0);
    const counts = await api.getUnreadCounts();
    expect(counts.find((c: any) => c.id === States.ALL).count).toBe(3);
  });

  test("rename and delete tags", async () => {
    await api.renameTag("News", "Headlines");
    const rss = (await api.getFeeds()).find((f: any) => f.url === RSS)!;
    expect(rss.categories[0].label).toBe("Headlines");
    // merging into an existing folder
    await api.renameTag("Headlines", "Blogs");
    const feeds = await api.getFeeds();
    expect(feeds.every((f: any) => f.categories[0]?.label === "Blogs")).toBe(true);
    const res = await raw("disable-tag", { method: "POST", body: new URLSearchParams({ s: "user/-/label/Blogs" }) });
    expect(res.status).toBe(200);
    expect((await api.getFeeds()).every((f: any) => f.categories.length === 0)).toBe(true);
  });

  test("unsubscribe deletes items", async () => {
    await api.removeFeed(RSS);
    const feeds = await api.getFeeds();
    expect(feeds.map((f: any) => f.url)).toEqual([ATOM]);
    expect(await api.getItems(States.ALL, { num: 100 })).toHaveLength(3);
  });
});
