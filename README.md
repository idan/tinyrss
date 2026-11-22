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

## Deploying with Docker / Coolify

The repo includes a `Dockerfile` (runs as non-root, with a built-in healthcheck) and a
`docker-compose.yml`. Inside the container:

- the database lives at `/data/tinyrss.db`, so **`/data` must be a persistent volume**. If it isn't, the
  server logs a warning and shows a banner in the web UI;
- the CLI is available as `tinyrss <command>`, e.g. `tinyrss refresh`;
- credentials can come from `TINYRSS_USERNAME` (default `admin`) / `TINYRSS_PASSWORD`. They are
  applied at startup. If they changed, all apps and browsers are logged out. If you prefer to
  manage the password with `tinyrss set-password`, leave `TINYRSS_PASSWORD` empty.

### Coolify (Docker Compose build pack, recommended)

The compose file declares the volume, so there's no way to forget it.

1. Push this repo to GitHub/GitLab (Coolify can deploy private repos via its GitHub App).
2. Point a DNS record (e.g. `rss.example.com`) at your Coolify server.
3. In Coolify: **Project → New Resource → (Public/Private) Repository**, pick the repo and branch,
   then set **Build Pack** to **Docker Compose** (compose file `/docker-compose.yml`).
4. **Domains**: on the `tinyrss` service, set the domain to `https://rss.example.com:8080`.
   The `:8080` tells Coolify's proxy which container port to route to. It is not exposed
   publicly, and HTTPS certificates are issued automatically.
5. **Environment Variables**: Coolify lists the variables found in the compose file. Set
   `TINYRSS_PASSWORD` (≥ 8 characters) and optionally `TINYRSS_USERNAME`. For off-site
   backups, also fill in the `TINYRSS_BACKUP_S3_*` variables (see [Backups](#backups--restore)).
6. **Deploy**. The logs should show `tinyrss listening on …`, no volume warning, and a
   `backups: …` line confirming where backups go. The first backup is written 30 seconds after
   startup.
7. Open `https://rss.example.com`, log in, and import your OPML (or add feeds).
8. In your reader apps use `https://rss.example.com/api/greader` as the server URL.

### Coolify (Dockerfile build pack)

Same as above, but choose **Dockerfile** as the build pack, then:

- set **Ports Exposes** to `8080` and the domain to `https://rss.example.com`;
- under **Persistent Storage**, add a **Volume Mount** with destination `/data`. Use a volume, not a
  directory (bind) mount: a new volume inherits the right ownership from the image, while a host
  directory has to be `chown 1000:1000`;
- add the environment variables under **Environment Variables**.

## Backups & restore

Backups are built in. You don't need a Coolify Scheduled Task.

- **Automatic:** every 24h (`TINYRSS_BACKUP_INTERVAL_HOURS`) a consistent snapshot is written to
  `/data/backups`, keeping the latest 14 (`TINYRSS_BACKUP_KEEP`). The web UI also has a
  **Back up now** button and download links.
- **Before every schema upgrade:** a `pre-migration-vX-to-vY` snapshot is taken automatically.
  Before every restore, the replaced database is kept as `pre-restore`. The 5 most recent of each
  kind are kept.
- **Off-site (recommended):** backups on the same volume don't survive losing the volume or the
  server. Set `TINYRSS_BACKUP_S3_BUCKET` and credentials, and every scheduled/manual backup is also
  uploaded (gzipped) to any S3-compatible storage, with the same rotation. Coolify's own backup
  feature only covers databases it manages, but you can reuse the credentials of an S3 storage you
  set up in Coolify. Upload problems appear in the logs and in the web UI.

```sh
TINYRSS_BACKUP_S3_BUCKET=my-backups
TINYRSS_BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # omit for AWS S3
TINYRSS_BACKUP_S3_REGION=auto                                          # AWS: e.g. eu-central-1
TINYRSS_BACKUP_S3_ACCESS_KEY_ID=...
TINYRSS_BACKUP_S3_SECRET_ACCESS_KEY=...
TINYRSS_BACKUP_S3_PREFIX=tinyrss/                                      # default
```

**Restoring** (in Coolify: the service's **Terminal** tab):

```sh
tinyrss backups                       # lists local backups, and S3 backups as s3:<name>
tinyrss restore tinyrss-…-scheduled.db    # or s3:tinyrss-….db.gz, or a path
# then restart the container (Coolify: Restart)
```

`restore` checks the backup (SQLite integrity check, and a schema version this release can read)
and stages it. The swap happens when the server starts, so a restore never runs under a live
server, and the database it replaces is backed up first. `tinyrss restore --cancel` un-stages it.
To recover from a lost volume, deploy normally on a fresh volume, then restore from `s3:…`.

**Rolling back a release.** Older releases can't read a database that a newer release has already
upgraded. If you roll back across a schema change, tinyrss doesn't crash-loop. It starts in
**maintenance mode**, which serves a page explaining the problem and fails the healthcheck. The
container keeps running, so you can open its terminal and either redeploy the newer release or
`tinyrss restore` the `pre-migration` backup. In maintenance mode a staged restore is picked up
within seconds, without a restart.

### Plain Docker

```sh
docker build -t tinyrss .
docker run -d --name tinyrss --restart unless-stopped \
  -p 8080:8080 -v tinyrss-data:/data -e TINYRSS_PASSWORD='change me please' tinyrss
# or: uncomment `ports:` in docker-compose.yml and run `docker compose up -d`
```

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
  backup [--to FILE]                 Back up now (rotated, uploaded to S3 if configured),
                                     or write a single snapshot to FILE
  backups                            List local and S3 backups
  restore <name|path|s3:name>        Stage a restore, applied on next start (--cancel to undo)

  --db PATH                          Database path (default $TINYRSS_DB or ./data/tinyrss.db)
```

The CLI can be used while the server is running (SQLite WAL mode); the server picks up newly
imported feeds within a minute.

## Configuration

Environment variables (Bun loads `.env` automatically):

| Variable                    | Default              | Description                                          |
| --------------------------- | -------------------- | ---------------------------------------------------- |
| `TINYRSS_DB`                | `./data/tinyrss.db`  | SQLite database path (`/data/tinyrss.db` in Docker)  |
| `TINYRSS_USERNAME`          | `admin`              | Username applied at startup (only if `TINYRSS_PASSWORD` is set) |
| `TINYRSS_PASSWORD`          |                      | If set, the password is (re)applied at startup       |
| `PORT` / `HOST`             | `8080` / `0.0.0.0`   | Listen address                                       |
| `TINYRSS_FETCH_INTERVAL`    | `30`                 | Minutes between refreshes of each feed               |
| `TINYRSS_RETENTION_DAYS`    | `90`                 | Read, unstarred, unlabelled items older than this are deleted (`0` = keep forever) |
| `TINYRSS_FETCH_CONCURRENCY` | `6`                  | Feeds fetched in parallel                            |
| `TINYRSS_USER_AGENT`        |                      | User-Agent sent when fetching feeds                  |
| `TINYRSS_BACKUP_DIR`        | `<db dir>/backups`   | Where local backups are written                      |
| `TINYRSS_BACKUP_INTERVAL_HOURS` | `24`             | Hours between automatic backups (`0` = off)          |
| `TINYRSS_BACKUP_KEEP`       | `14`                 | Automatic/manual backups to keep (locally and in S3) |
| `TINYRSS_BACKUP_S3_*`       |                      | Off-site backups: `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `PREFIX` |

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
  db.ts       opening the database, migration runner
  migrations.ts  the schema migrations (append-only)
  backup.ts   backups, rotation, S3 upload, staged restores
  snapshot.ts consistent snapshots (VACUUM INTO)
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
bun test        # parser, OPML, GReader API (via libseymour), web UI, migrations, backups
bun check       # type check
bun run dev     # server with --watch
```

The S3 tests are skipped unless you point them at an S3-compatible server, e.g. SeaweedFS:

```sh
TINYRSS_TEST_S3_ENDPOINT=http://127.0.0.1:8333 TINYRSS_TEST_S3_BUCKET=tinyrss-test \
TINYRSS_TEST_S3_ACCESS_KEY_ID=… TINYRSS_TEST_S3_SECRET_ACCESS_KEY=… bun test
```

### Changing the schema

Migrations are plain SQL (or functions) in `src/migrations.ts`, applied in order on startup and
tracked with SQLite's `user_version`. Each one runs in its own transaction, so a failure leaves
the database as it was.

1. **Append** a migration. Never edit, reorder or remove one that has been released.
2. For changes `ALTER TABLE` can't do (changing a column's type or constraints), use SQLite's table
   rebuild (create `x_new`, copy, drop `x`, rename, recreate indexes) and set
   `disableForeignKeys: true`. Otherwise dropping `feeds` would cascade-delete every item.
   With the flag set, `PRAGMA foreign_key_check` must pass before the migration commits.
3. Run `bun run db:snapshot` and commit the new `test/fixtures/db/vN.sql`. It is a database at the
   new version, filled with sample data.
4. `bun test`. The migration tests upgrade **every** committed fixture version to the latest, check
   that no data was lost, and run the API against the result. They also fail if an
   already-released migration was modified.
