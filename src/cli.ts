#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { getUsername, hasCredentials, listTokens, revokeAllTokens, setCredentials } from "./auth.ts";
import { config } from "./config.ts";
import {
  backupSettings,
  cancelPendingRestore,
  createBackup,
  describeS3Error,
  fmtBytes,
  listLocalBackups,
  listS3Backups,
  stageRestore,
} from "./backup.ts";
import { type DB, openDb } from "./db.ts";
import { snapshotTo } from "./snapshot.ts";
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
  backup [--to FILE]                 Back up now (to the backup dir, rotated, and to S3 if
                                     configured), or write a single snapshot to FILE
  backups                            List local (and S3) backups
  restore <name|path|s3:name>        Stage a backup to be restored on the next server start
  restore --cancel                   Cancel a staged restore

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
      to: { type: "string" },
      cancel: { type: "boolean" },
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

  const backups = backupSettings(dbPath);

  // Commands that must work even if the database can't be opened (e.g. it's too new or broken).
  if (cmd === "backups") {
    const local = listLocalBackups(backups.dir);
    console.log(`Local backups in ${backups.dir}:`);
    if (!local.length) console.log("  (none)");
    for (const b of local) console.log(`  ${b.name}  ${fmtBytes(b.size)}`);
    if (backups.s3) {
      console.log(`\nS3 backups in s3://${backups.s3.bucket}/${backups.s3.prefix}:`);
      try {
        const remote = await listS3Backups(backups.s3);
        if (!remote.length) console.log("  (none)");
        for (const b of remote) console.log(`  s3:${b.name}  ${fmtBytes(b.size)}`);
      } catch (e) {
        console.log(`  (unavailable: ${describeS3Error(e, backups.s3)})`);
        process.exitCode = 1;
      }
    }
    return;
  }
  if (cmd === "restore") {
    if (values.cancel) {
      console.log(cancelPendingRestore(dbPath) ? "Staged restore cancelled." : "No restore was staged.");
      return;
    }
    if (!args[0]) throw new Error("usage: restore <name|path|s3:name>  (see `backups`)");
    const { label, version } = await stageRestore(dbPath, args[0], backups);
    console.log(`Staged ${label} (schema v${version}).`);
    console.log(
      "It is applied when tinyrss starts (restart the container), or within seconds if the server is in\n" +
        "maintenance mode. The current database is backed up first; `tinyrss restore --cancel` undoes this.",
    );
    return;
  }

  const db: DB = openDb(dbPath, {
    backupDir: backups.dir,
    onBackup: (file, from, to) => console.log(`Upgraded database schema v${from} → v${to} (backup: ${file})`),
  });
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
      case "backup": {
        if (values.to) {
          console.log(`Wrote ${snapshotTo(db, values.to)}`);
          break;
        }
        const r = await createBackup(db, backups, "manual");
        console.log(`Wrote ${r.file} (${fmtBytes(r.size)})`);
        if (r.pruned.length) console.log(`Removed ${r.pruned.length} old backup(s).`);
        if (r.s3Key) console.log(`Uploaded to s3://${backups.s3!.bucket}/${r.s3Key}`);
        if (r.s3Error) throw new Error(`upload to S3 failed: ${r.s3Error}`);
        break;
      }
      case "refresh":
        await refresh(db, !!values.force);
        break;
      default:
        throw new Error(`unknown command "${cmd}" (see --help)`);
    }
  } finally {
    db.close();
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
