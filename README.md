# tinyrss

A small, single-user RSS/Atom/JSON Feed aggregator written in TypeScript for [Bun](https://bun.sh).

- Fetches feeds in the background and stores everything in one SQLite file
- Exposes a **Google Reader (GReader) compatible API**, so you can use reader apps like
  Reeder, NetNewsWire, ReadKit, FeedMe, Read You, FocusReader, Fluent Reader, …
- Has a minimal web UI for managing subscriptions and folders, and importing/exporting OPML
- Has a CLI for credentials, OPML import/export and feed management

Dependencies: [Hono](https://hono.dev) (HTTP routing) and
[fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) (pure-JS XML parsing).
Tests use [libseymour](https://github.com/bhj/libseymour) as a real GReader client.

## Quick start

```sh
bun install
bun run cli set-password me           # prompts for a password (min. 8 chars)
bun run cli import subscriptions.opml # optional
bun run start                         # http://localhost:8080
```

Open `http://localhost:8080` and log in to manage subscriptions.

### Connecting a reader app

Pick the **"FreshRSS"** or **"Google Reader API"** account type in your app and use:

| Field    | Value                                    |
| -------- | ---------------------------------------- |
| Server   | `https://your-host/api/greader`          |
| Username | the username you set with `set-password` |
| Password | the password you set                     |

The API is also served at `/api/greader.php` and at the host root (`/accounts/ClientLogin`,
`/reader/api/0/…`) for clients that expect those. Run it behind a TLS-terminating reverse proxy
(Caddy, nginx, Tailscale serve, …) if it's reachable from outside your machine; `X-Forwarded-Proto`
and `X-Forwarded-Host` are respected.

## CLI

```
bun run cli <command>

  serve [--port N] [--host H]        Run the web server and feed fetcher
  set-password [username]            Set username/password (--password-stdin to pipe it in).
                                     Changing credentials logs out all apps and sessions.
  whoami                             Show the configured username
  sessions                           List logged in apps / browser sessions
  revoke [--api | --web]             Log out all apps and/or browser sessions
  import <file.opml> [--fetch]       Import subscriptions from OPML
  export [file.opml]                 Export subscriptions as OPML
  add <url> [--folder F] [--title T] Subscribe (website URLs are auto-discovered)
  remove <url-or-id>                 Unsubscribe
  list                               List subscriptions
  refresh [--force]                  Fetch all feeds now

  --db PATH                          Database path (default $TINYRSS_DB or ./data/tinyrss.db)
```

The CLI can be used while the server is running (SQLite WAL mode); the server picks up newly
imported feeds within a minute.

## Configuration

Environment variables (Bun loads `.env` automatically):

| Variable                    | Default              | Description                                          |
| --------------------------- | -------------------- | ---------------------------------------------------- |
| `TINYRSS_DB`                | `./data/tinyrss.db`  | SQLite database path                                 |
| `PORT` / `HOST`             | `8080` / `0.0.0.0`   | Listen address                                       |
| `TINYRSS_FETCH_INTERVAL`    | `30`                 | Minutes between refreshes of each feed               |
| `TINYRSS_RETENTION_DAYS`    | `90`                 | Read, unstarred, unlabelled items older than this are deleted (`0` = keep forever) |
| `TINYRSS_FETCH_CONCURRENCY` | `6`                  | Feeds fetched in parallel                            |
| `TINYRSS_USER_AGENT`        |                      | User-Agent sent when fetching feeds                  |

## How it works

```
src/
  server.ts   Bun.serve + background scheduler
  app.ts      mounts the GReader API and the web UI
  greader.ts  Google Reader API (ClientLogin, subscriptions, tags, streams, edit-tag, …)
  web.ts      server-rendered management UI (cookie sessions, CSRF origin check)
  fetcher.ts  HTTP fetching (ETag/Last-Modified, backoff on errors), feed autodiscovery
  parser.ts   RSS 0.9x/1.0/2.0, Atom and JSON Feed parsing
  opml.ts     OPML import/export
  store.ts    SQLite data access
  auth.ts     credentials (argon2id via Bun.password) and tokens (stored hashed)
  db.ts       schema & migrations
  cli.ts      command line interface
```

- Stream IDs follow the common convention: `feed/<feed url>`, `user/-/label/<folder>`,
  `user/-/state/com.google/{reading-list,read,starred,kept-unread}`.
- A feed belongs to at most one folder. Labels can also be put on individual items.
- Supported endpoints: `accounts/ClientLogin`, `token`, `user-info`, `subscription/{list,edit,quickadd,export,import}`,
  `subscribed`, `tag/list`, `rename-tag`, `disable-tag`, `unread-count`, `stream/contents`,
  `stream/items/{ids,contents,count}`, `edit-tag`, `mark-all-as-read`, `preference/list`.
- Feeds that fail are retried with exponential backoff (up to once a day); the error is shown in the UI.

## Development

```sh
bun test        # parser, OPML, GReader API (via libseymour) and web UI tests
bun check       # type check
bun run dev     # server with --watch
```
