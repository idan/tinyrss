#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getUsername, hasCredentials, listTokens, revokeAllTokens, setCredentials } from "./auth.ts";
import { config } from "./config.ts";
import { type DB, openDb } from "./db.ts";
import { discoverFeed, fetchFeed, fetchFeeds } from "./fetcher.ts";
import { exportOpml, importOpml } from "./opml.ts";
import { addFeed, deleteFeed, feedDisplayTitle, findFeed, listFeeds } from "./store.ts";

const HELP = `tinyrss — single-user RSS reader with a Google Reader compatible API

Usage: bun run cli <command> [options]   (in the Docker image: tinyrss <command>)

Commands:
  serve [--port N] [--host H]        Run the web server and feed fetcher
  set-password [username]            Set the username and password (prompts for password;
                                     use --password-stdin to read it from stdin).
                                     Changing credentials logs out all apps and sessions.
  whoami                             Show the configured username
  sessions                           List logged in apps / browser sessions
  revoke [--api | --web]             Log out all apps and/or browser sessions
  import <file.opml> [--fetch]       Import subscriptions from OPML
  export [file.opml]                 Export subscriptions as OPML (stdout by default)
  add <url> [--folder F] [--title T] Subscribe to a feed (or a site that advertises one)
  remove <url-or-id>                 Unsubscribe
  list                               List subscriptions
  refresh [--force]                  Fetch all feeds now
  backup <file> [--keep N]           Write a consistent snapshot of the database (safe while
                                     the server runs). "{date}" in the name is replaced by a
                                     timestamp; --keep prunes older snapshots of that pattern.

Global options:
  --db PATH     SQLite database path (default: $TINYRSS_DB or ./data/tinyrss.db)
`;

async function readPasswordFromTty(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("stdin is not a terminal; use --password-stdin");
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let pw = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          return resolve(pw);
        } else if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          return reject(new Error("aborted"));
        } else if (ch === "\u007f" || ch === "\b") {
          pw = pw.slice(0, -1);
        } else {
          pw += ch;
        }
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  return (await Bun.stdin.text()).replace(/\r?\n$/, "");
}

function fmtDate(ms: number | null) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) : "never";
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: {
      db: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      folder: { type: "string" },
      title: { type: "string" },
      fetch: { type: "boolean" },
      force: { type: "boolean" },
      keep: { type: "string" },
      api: { type: "boolean" },
      web: { type: "boolean" },
      "password-stdin": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help || cmd === "help") {
    console.log(HELP);
    return;
  }
  const dbPath = values.db ?? config.dbPath;

  if (cmd === "serve") {
    const { serve } = await import("./server.ts");
    await serve({ dbPath, port: values.port ? Number(values.port) : undefined, hostname: values.host });
    return;
  }

  const db: DB = openDb(dbPath);
  try {
    switch (cmd) {
      case "set-password": {
        let username = args[0] ?? getUsername(db);
        if (!username) {
          if (values["password-stdin"]) throw new Error("username argument is required");
          username = prompt("Username:")?.trim() ?? "";
        }
        let password: string;
        if (values["password-stdin"]) {
          password = await readStdin();
        } else {
          password = await readPasswordFromTty("Password: ");
          const again = await readPasswordFromTty("Repeat password: ");
          if (password !== again) throw new Error("passwords do not match");
        }
        if (config.password) {
          console.warn("warning: TINYRSS_PASSWORD is set; the server will reset the password to it on next start.");
        }
        const had = hasCredentials(db);
        await setCredentials(db, username, password);
        console.log(`Credentials set for "${username}".${had ? " All existing sessions were logged out." : ""}`);
        break;
      }
      case "whoami":
        console.log(getUsername(db) ?? "(no credentials configured)");
        break;
      case "sessions": {
        const tokens = listTokens(db);
        if (!tokens.length) console.log("No sessions.");
        for (const t of tokens) {
          console.log(`${t.kind.padEnd(4)}  created ${fmtDate(t.created_at)}  last used ${fmtDate(t.last_used_at)}  ${t.label ?? ""}`);
        }
        break;
      }
      case "revoke": {
        const kind = values.api && !values.web ? "api" : values.web && !values.api ? "web" : undefined;
        console.log(`Revoked ${revokeAllTokens(db, kind)} session(s).`);
        break;
      }
      case "import": {
        if (!args[0]) throw new Error("usage: import <file.opml>");
        const res = importOpml(db, await Bun.file(args[0]).text());
        console.log(`Imported ${res.added} feed(s), ${res.skipped} already subscribed.`);
        for (const e of res.errors) console.error(`  error: ${e}`);
        if (values.fetch) await refresh(db, false);
        else console.log("New feeds will be fetched by the running server (or run `refresh`).");
        break;
      }
      case "export": {
        const xml = exportOpml(db);
        if (args[0]) {
          await Bun.write(args[0], xml);
          console.log(`Wrote ${args[0]}`);
        } else process.stdout.write(xml);
        break;
      }
      case "add": {
        if (!args[0]) throw new Error("usage: add <url> [--folder F]");
        const { url, feed: parsed } = await discoverFeed(args[0]);
        const { feed, created } = addFeed(db, { url, tag: values.folder, title: values.title });
        if (!created) {
          console.log(`Already subscribed: ${feedDisplayTitle(feed)} (${feed.url})`);
          break;
        }
        const r = await fetchFeed(db, feed.id);
        console.log(`Subscribed to ${parsed.title ?? url} (${url}): ${r.status === "error" ? r.error : `${r.newItems} items`}`);
        break;
      }
      case "remove": {
        if (!args[0]) throw new Error("usage: remove <url-or-id>");
        const feed = findFeed(db, args[0]);
        if (!feed) throw new Error(`no subscription matches ${args[0]}`);
        deleteFeed(db, feed.id);
        console.log(`Unsubscribed from ${feedDisplayTitle(feed)}.`);
        break;
      }
      case "list": {
        for (const f of listFeeds(db)) {
          const err = f.last_error ? `  ⚠ ${f.last_error}` : "";
          console.log(`${String(f.id).padStart(4)}  [${f.tag_name ?? "-"}] ${feedDisplayTitle(f)}  <${f.url}>  ${f.unread}/${f.total} unread${err}`);
        }
        break;
      }
      case "refresh":
        await refresh(db, !!values.force);
        break;
      case "backup": {
        if (!args[0]) throw new Error("usage: backup <file> [--keep N]");
        await backup(db, args[0], values.keep ? Number(values.keep) : undefined);
        break;
      }
      default:
        throw new Error(`unknown command "${cmd}" (see --help)`);
    }
  } finally {
    db.close();
  }
}

async function backup(db: DB, pattern: string, keep?: number) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = resolve(pattern.replace("{date}", stamp));
  if (existsSync(target)) throw new Error(`${target} already exists`);
  mkdirSync(dirname(target), { recursive: true });
  db.query("VACUUM INTO ?").run(target);
  console.log(`Backed up to ${target}`);
  if (keep !== undefined && pattern.includes("{date}")) {
    if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be a positive integer");
    const [prefix, suffix] = basename(pattern).split("{date}") as [string, string];
    const old = readdirSync(dirname(target))
      .filter((f) => f.startsWith(prefix) && f.endsWith(suffix) && f.length === prefix.length + stamp.length + suffix.length)
      .sort()
      .slice(0, -keep);
    for (const f of old) rmSync(join(dirname(target), f));
    if (old.length) console.log(`Removed ${old.length} old backup(s).`);
  }
}

async function refresh(db: DB, force: boolean) {
  const feeds = listFeeds(db);
  const results = await fetchFeeds(
    db,
    feeds.map((f) => f.id),
    { force },
  );
  for (const [i, r] of results.entries()) {
    const f = feeds[i]!;
    if (r.status === "error") console.log(`  ✗ ${feedDisplayTitle(f)}: ${r.error}`);
    else if (r.newItems) console.log(`  + ${feedDisplayTitle(f)}: ${r.newItems} new`);
  }
  console.log(`Refreshed ${results.length} feed(s): ${results.reduce((n, r) => n + r.newItems, 0)} new item(s).`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
