import { afterAll, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { setCredentials } from "../src/auth.ts";
import { openDb } from "../src/db.ts";
import { listFeeds } from "../src/store.ts";
import { startFixtureServer } from "./fixtures.ts";

const fixtures = startFixtureServer();
afterAll(() => fixtures.server.stop(true));

const db = openDb(":memory:");
const app = createApp(db);
const H = "http://tinyrss.test";

function form(data: Record<string, string>, cookie?: string) {
  return {
    method: "POST",
    body: new URLSearchParams(data),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: H, host: "tinyrss.test", ...(cookie ? { cookie } : {}) },
  };
}

test("shows setup hint when no credentials exist", async () => {
  const res = await app.request(`${H}/login`);
  expect(await res.text()).toContain("set-password");
});

test("login, add feed, manage, logout", async () => {
  await setCredentials(db, "me", "password123");

  expect((await app.request(`${H}/`)).headers.get("location")).toBe("/login");

  const bad = await app.request(`${H}/login`, form({ username: "me", password: "nope" }));
  expect(bad.headers.get("location")).toBe("/login?error=1");

  const login = await app.request(`${H}/login`, form({ username: "me", password: "password123" }));
  expect(login.status).toBe(303);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookie).toStartWith("tinyrss_session=");

  // cross-origin posts are rejected
  const csrf = await app.request(`${H}/feeds`, {
    ...form({ url: fixtures.url("/blog") }, cookie),
    headers: { ...form({}, cookie).headers, origin: "https://evil.example" },
  });
  expect(csrf.status).toBe(403);

  // adding a website discovers its feed
  const add = await app.request(`${H}/feeds`, form({ url: fixtures.url("/blog"), folder: "Blogs" }, cookie));
  expect(add.status).toBe(303);
  const feeds = listFeeds(db);
  expect(feeds).toHaveLength(1);
  expect(feeds[0]).toMatchObject({ url: fixtures.url("/atom.xml"), tag_name: "Blogs", feed_title: "Example Atom", total: 3 });

  const home = await (await app.request(`${H}/`, { headers: { cookie } })).text();
  expect(home).toContain("Example Atom");
  expect(home).toContain("/api/greader");

  const id = feeds[0]!.id;
  const detail = await (await app.request(`${H}/feeds/${id}`, { headers: { cookie } })).text();
  expect(detail).toContain("Atom two");

  await app.request(`${H}/feeds/${id}`, form({ url: fixtures.url("/atom.xml"), title: "<b>Mine</b>", folder: "" }, cookie));
  expect(listFeeds(db)[0]).toMatchObject({ title: "<b>Mine</b>", tag_name: null });
  // output is escaped
  expect(await (await app.request(`${H}/`, { headers: { cookie } })).text()).toContain("&lt;b&gt;Mine&lt;/b&gt;");

  // OPML import via upload
  const fd = new FormData();
  fd.append(
    "file",
    new File([`<opml><body><outline text="X"><outline xmlUrl="${fixtures.url("/feed.json")}"/></outline></body></opml>`], "a.opml"),
  );
  const imp = await app.request(`${H}/import`, { method: "POST", body: fd, headers: { cookie, origin: H, host: "tinyrss.test" } });
  expect(new URL(imp.headers.get("location")!, H).searchParams.get("msg")).toContain("Imported 1 feeds");
  expect(listFeeds(db)).toHaveLength(2);

  const opml = await (await app.request(`${H}/export.opml`, { headers: { cookie } })).text();
  expect(opml).toContain(fixtures.url("/feed.json"));

  await app.request(`${H}/feeds/${id}/delete`, form({}, cookie));
  expect(listFeeds(db)).toHaveLength(1);

  await app.request(`${H}/logout`, form({}, cookie));
  expect((await app.request(`${H}/`, { headers: { cookie } })).headers.get("location")).toBe("/login");
});
