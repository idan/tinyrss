/** Minimal server-rendered web UI for managing subscriptions. */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html, raw } from "hono/html";
import { checkToken, createToken, getUsername, hasCredentials, revokeToken, verifyCredentials } from "./auth.ts";
import type { DB } from "./db.ts";
import { discoverFeed, fetchFeed, fetchFeeds } from "./fetcher.ts";
import { exportOpml, importOpml } from "./opml.ts";
import { addFeed, deleteFeed, deleteTag, feedDisplayTitle, getFeed, listFeeds, listTags, renameTag, updateFeed } from "./store.ts";

const COOKIE = "tinyrss_session";

const CSS = `
:root { color-scheme: light dark; --muted: #888; --accent: #e8710a; --border: #8884; }
* { box-sizing: border-box; }
body { font: 15px/1.45 system-ui, sans-serif; max-width: 960px; margin: 0 auto; padding: 1rem; }
header { display: flex; align-items: center; gap: 1rem; border-bottom: 1px solid var(--border); padding-bottom: .5rem; margin-bottom: 1rem; }
header h1 { font-size: 1.25rem; margin: 0; flex: 1; }
header h1 a { color: inherit; text-decoration: none; }
h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
a { color: var(--accent); }
table { width: 100%; border-collapse: collapse; }
td, th { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
th { font-weight: 600; font-size: .85rem; color: var(--muted); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.muted, small { color: var(--muted); }
.error { color: #d33; }
.flash { padding: .5rem .75rem; border: 1px solid var(--border); border-left: 4px solid var(--accent); margin-bottom: 1rem; white-space: pre-wrap; }
form.inline { display: inline; }
form.row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
input[type=text], input[type=url], input[type=password], input:not([type]) { padding: .35rem .5rem; font: inherit; min-width: 0; }
form.row input[name=url] { flex: 2 1 16rem; }
form.row input[name=folder], form.row input[name=to] { flex: 1 1 8rem; }
button { font: inherit; padding: .35rem .75rem; cursor: pointer; }
button.link { background: none; border: none; color: var(--accent); padding: 0; text-decoration: underline; }
label { display: block; margin: .5rem 0 .2rem; font-weight: 600; }
.stack input { width: 100%; }
.actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
code { background: #8882; padding: .1rem .3rem; border-radius: 3px; word-break: break-all; }
.title { word-break: break-word; }
`;

function fmtAgo(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 0) return "in " + fmtDuration(-s);
  return fmtDuration(s) + " ago";
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function page(title: string, body: unknown, opts: { nav?: boolean; flash?: string | null } = {}) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · tinyrss</title>
        <style>
          ${raw(CSS)}
        </style>
      </head>
      <body>
        <header>
          <h1><a href="/">tinyrss</a></h1>
          ${opts.nav
            ? html`<a href="/export.opml">Export OPML</a>
                <form class="inline" method="post" action="/logout"><button class="link">Log out</button></form>`
            : ""}
        </header>
        ${opts.flash ? html`<div class="flash">${opts.flash}</div>` : ""} ${body}
      </body>
    </html>`;
}

function redirectWithFlash(c: Context, to: string, msg: string) {
  const u = new URL(to, "http://x");
  u.searchParams.set("msg", msg);
  return c.redirect(u.pathname + u.search, 303);
}

function isHttps(c: Context): boolean {
  return (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https";
}

function apiBaseUrl(c: Context): string {
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
  return `${proto}://${host}/api/greader`;
}

export function webUi(db: DB): Hono {
  const app = new Hono();

  // CSRF protection: reject cross-origin form posts. (The session cookie is also SameSite=Lax.)
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
      if (origin && origin !== "null") {
        let ok = false;
        try {
          ok = new URL(origin).host === host;
        } catch {}
        if (!ok) return c.text("cross-origin request rejected", 403);
      }
    }
    await next();
  });

  app.get("/login", (c) => {
    const err = c.req.query("error");
    const setup = !hasCredentials(db);
    return c.html(
      page(
        "Log in",
        setup
          ? html`<p>No credentials are configured yet. Run:</p>
              <p><code>bun run cli set-password &lt;username&gt;</code></p>`
          : html`<form method="post" action="/login" class="stack" style="max-width: 22rem">
              ${err ? html`<p class="error">Invalid username or password.</p>` : ""}
              <label for="u">Username</label><input id="u" name="username" autocomplete="username" required autofocus />
              <label for="p">Password</label
              ><input id="p" name="password" type="password" autocomplete="current-password" required />
              <div class="actions"><button>Log in</button></div>
            </form>`,
      ),
    );
  });

  app.post("/login", async (c) => {
    const form = await c.req.parseBody();
    const ok = await verifyCredentials(db, String(form.username ?? ""), String(form.password ?? ""));
    if (!ok) {
      await Bun.sleep(1000);
      return c.redirect("/login?error=1", 303);
    }
    setCookie(c, COOKIE, createToken(db, "web", c.req.header("user-agent")?.slice(0, 200)), {
      httpOnly: true,
      sameSite: "Lax",
      secure: isHttps(c),
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return c.redirect("/", 303);
  });

  // Everything below requires a session.
  app.use("*", async (c, next) => {
    if (!checkToken(db, "web", getCookie(c, COOKIE))) return c.redirect("/login", 303);
    await next();
  });

  app.post("/logout", (c) => {
    const token = getCookie(c, COOKIE);
    if (token) revokeToken(db, token);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.redirect("/login", 303);
  });

  app.get("/", (c) => {
    const feeds = listFeeds(db);
    const tags = listTags(db);
    const totalUnread = feeds.reduce((n, f) => n + f.unread, 0);
    const groups = new Map<string, typeof feeds>();
    for (const f of feeds) {
      const key = f.tag_name ?? "";
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    const body = html`
      <p class="muted">
        ${feeds.length} subscriptions · ${totalUnread} unread · Reader app URL: <code>${apiBaseUrl(c)}</code> (user
        <code>${getUsername(db) ?? ""}</code>)
      </p>

      <h2>Add subscription</h2>
      <form method="post" action="/feeds" class="row">
        <input name="url" type="text" placeholder="Feed or website URL" required />
        <input name="folder" placeholder="Folder (optional)" list="folders" />
        <button>Add</button>
      </form>
      <datalist id="folders">${tags.map((t) => html`<option value="${t.name}"></option>`)}</datalist>

      <h2>Subscriptions</h2>
      <div class="actions" style="margin: 0 0 .5rem">
        <form method="post" action="/refresh" class="inline"><button>Refresh all now</button></form>
      </div>
      ${feeds.length === 0
        ? html`<p class="muted">No subscriptions yet.</p>`
        : html`<table>
            <thead>
              <tr>
                <th>Feed</th>
                <th class="num">Unread</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              ${[...groups].map(
                ([folder, list]) => html`
                  <tr>
                    <th colspan="3" style="padding-top: 1rem">${folder || "No folder"}</th>
                  </tr>
                  ${list.map(
                    (f) => html`<tr>
                      <td class="title">
                        <a href="/feeds/${f.id}">${feedDisplayTitle(f)}</a>
                        ${f.last_error ? html`<br /><small class="error">⚠ ${f.last_error}</small>` : ""}
                      </td>
                      <td class="num">${f.unread}</td>
                      <td><small>${fmtAgo(f.last_fetched_at)}</small></td>
                    </tr>`,
                  )}
                `,
              )}
            </tbody>
          </table>`}

      <h2>Folders</h2>
      ${tags.length === 0
        ? html`<p class="muted">No folders.</p>`
        : html`<table>
            ${tags.map(
              (t) => html`<tr>
                <td>${t.name} <small>(${t.feed_count} feeds${t.item_count ? `, ${t.item_count} labelled items` : ""})</small></td>
                <td>
                  <form method="post" action="/folders/rename" class="row">
                    <input type="hidden" name="from" value="${t.name}" />
                    <input name="to" placeholder="New name" required />
                    <button>Rename</button>
                  </form>
                </td>
                <td>
                  <form
                    method="post"
                    action="/folders/delete"
                    class="inline"
                    onsubmit="return confirm('Delete folder? Feeds are kept.')"
                  >
                    <input type="hidden" name="name" value="${t.name}" /><button class="link">Delete</button>
                  </form>
                </td>
              </tr>`,
            )}
          </table>`}

      <h2>Import OPML</h2>
      <form method="post" action="/import" enctype="multipart/form-data" class="row">
        <input type="file" name="file" accept=".opml,.xml,text/xml,text/x-opml" required />
        <button>Import</button>
      </form>
    `;
    return c.html(page("Subscriptions", body, { nav: true, flash: c.req.query("msg") }));
  });

  app.post("/feeds", async (c) => {
    const form = await c.req.parseBody();
    const input = String(form.url ?? "").trim();
    const folder = String(form.folder ?? "").trim() || null;
    if (!input) return redirectWithFlash(c, "/", "URL is required");
    try {
      const { url } = await discoverFeed(input);
      const { feed, created } = addFeed(db, { url, tag: folder });
      if (!created) return redirectWithFlash(c, `/feeds/${feed.id}`, "Already subscribed.");
      const r = await fetchFeed(db, feed.id);
      const msg = r.status === "error" ? `Subscribed, but fetching failed: ${r.error}` : `Subscribed (${r.newItems} items).`;
      return redirectWithFlash(c, `/feeds/${feed.id}`, msg);
    } catch (e) {
      return redirectWithFlash(c, "/", `Could not subscribe: ${(e as Error).message}`);
    }
  });

  app.get("/feeds/:id{[0-9]+}", (c) => {
    const feed = getFeed(db, Number(c.req.param("id")));
    if (!feed) return c.notFound();
    const counts = db
      .query("SELECT COUNT(*) AS total, COALESCE(SUM(read = 0), 0) AS unread, COALESCE(SUM(starred), 0) AS starred FROM items WHERE feed_id = ?")
      .get(feed.id) as { total: number; unread: number; starred: number };
    const latest = db
      .query("SELECT title, url, published_at FROM items WHERE feed_id = ? ORDER BY published_at DESC LIMIT 10")
      .all(feed.id) as { title: string | null; url: string | null; published_at: number }[];
    const tags = listTags(db);
    const body = html`
      <h2>${feedDisplayTitle(feed)}</h2>
      <p class="muted">
        ${counts.total} items · ${counts.unread} unread · ${counts.starred} starred<br />
        Last fetched ${fmtAgo(feed.last_fetched_at)} · next fetch ${fmtAgo(feed.next_fetch_at)}
        ${feed.site_url ? html`<br />Website: <a href="${feed.site_url}" rel="noreferrer">${feed.site_url}</a>` : ""}
      </p>
      ${feed.last_error ? html`<p class="error">Last error (${feed.error_count}×): ${feed.last_error}</p>` : ""}

      <form method="post" action="/feeds/${feed.id}" class="stack">
        <label for="url">Feed URL</label><input id="url" name="url" type="url" value="${feed.url}" required />
        <label for="title">Title</label
        ><input id="title" name="title" value="${feed.title ?? ""}" placeholder="${feed.feed_title ?? ""}" />
        <label for="folder">Folder</label
        ><input id="folder" name="folder" value="${feed.tag_name ?? ""}" list="folders" placeholder="No folder" />
        <datalist id="folders">${tags.map((t) => html`<option value="${t.name}"></option>`)}</datalist>
        <div class="actions"><button>Save</button></div>
      </form>

      <div class="actions">
        <form method="post" action="/feeds/${feed.id}/refresh" class="inline"><button>Refresh now</button></form>
        <form method="post" action="/feeds/${feed.id}/mark-read" class="inline"><button>Mark all read</button></form>
        <form
          method="post"
          action="/feeds/${feed.id}/delete"
          class="inline"
          onsubmit="return confirm('Unsubscribe and delete all items of this feed?')"
        >
          <button>Unsubscribe</button>
        </form>
      </div>

      <h2>Latest items</h2>
      ${latest.length
        ? html`<table>
            ${latest.map(
              (i) => html`<tr>
                <td class="title">${i.url ? html`<a href="${i.url}" rel="noreferrer">${i.title || i.url}</a>` : i.title || "(untitled)"}</td>
                <td><small>${new Date(i.published_at * 1000).toISOString().slice(0, 10)}</small></td>
              </tr>`,
            )}
          </table>`
        : html`<p class="muted">No items.</p>`}
    `;
    return c.html(page(feedDisplayTitle(feed), body, { nav: true, flash: c.req.query("msg") }));
  });

  app.post("/feeds/:id{[0-9]+}", async (c) => {
    const id = Number(c.req.param("id"));
    const form = await c.req.parseBody();
    try {
      updateFeed(db, id, {
        url: String(form.url ?? ""),
        title: String(form.title ?? ""),
        tag: String(form.folder ?? ""),
      });
    } catch (e) {
      return redirectWithFlash(c, `/feeds/${id}`, `Error: ${(e as Error).message}`);
    }
    return redirectWithFlash(c, `/feeds/${id}`, "Saved.");
  });

  app.post("/feeds/:id{[0-9]+}/refresh", async (c) => {
    const id = Number(c.req.param("id"));
    const r = await fetchFeed(db, id, { force: true });
    return redirectWithFlash(c, `/feeds/${id}`, r.status === "error" ? `Error: ${r.error}` : `Refreshed: ${r.newItems} new items.`);
  });

  app.post("/feeds/:id{[0-9]+}/mark-read", (c) => {
    const id = Number(c.req.param("id"));
    const n = db.query("UPDATE items SET read = 1 WHERE feed_id = ? AND read = 0").run(id).changes;
    return redirectWithFlash(c, `/feeds/${id}`, `Marked ${n} items as read.`);
  });

  app.post("/feeds/:id{[0-9]+}/delete", (c) => {
    const feed = getFeed(db, Number(c.req.param("id")));
    if (feed) deleteFeed(db, feed.id);
    return redirectWithFlash(c, "/", feed ? `Unsubscribed from ${feedDisplayTitle(feed)}.` : "Not found.");
  });

  app.post("/refresh", async (c) => {
    const ids = listFeeds(db).map((f) => f.id);
    const results = await fetchFeeds(db, ids);
    const fresh = results.reduce((n, r) => n + r.newItems, 0);
    const errors = results.filter((r) => r.status === "error").length;
    return redirectWithFlash(c, "/", `Refreshed ${ids.length} feeds: ${fresh} new items, ${errors} errors.`);
  });

  app.post("/folders/rename", async (c) => {
    const form = await c.req.parseBody();
    try {
      renameTag(db, String(form.from ?? ""), String(form.to ?? ""));
    } catch (e) {
      return redirectWithFlash(c, "/", `Error: ${(e as Error).message}`);
    }
    return redirectWithFlash(c, "/", "Folder renamed.");
  });

  app.post("/folders/delete", async (c) => {
    const form = await c.req.parseBody();
    deleteTag(db, String(form.name ?? ""));
    return redirectWithFlash(c, "/", "Folder deleted.");
  });

  app.post("/import", async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) return redirectWithFlash(c, "/", "No file uploaded.");
    try {
      const res = importOpml(db, await file.text());
      // New feeds have next_fetch_at = 0, so the scheduler picks them up within a minute.
      const errs = res.errors.length ? `\nErrors:\n${res.errors.join("\n")}` : "";
      return redirectWithFlash(c, "/", `Imported ${res.added} feeds (${res.skipped} already subscribed). They will be fetched shortly.${errs}`);
    } catch (e) {
      return redirectWithFlash(c, "/", `Import failed: ${(e as Error).message}`);
    }
  });

  app.get("/export.opml", (c) =>
    c.body(exportOpml(db), 200, {
      "Content-Type": "text/x-opml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="tinyrss.opml"',
    }),
  );

  return app;
}
