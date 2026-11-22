import { type DB, getSetting, setSetting } from "./db.ts";

export type TokenKind = "api" | "web";

function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}

function sha256(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

function secret(db: DB): string {
  let s = getSetting(db, "secret");
  if (!s) {
    s = randomHex(32);
    setSetting(db, "secret", s);
  }
  return s;
}

export function getUsername(db: DB): string | null {
  return getSetting(db, "username");
}

export function hasCredentials(db: DB): boolean {
  return getSetting(db, "password_hash") !== null;
}

/** Set (or replace) the single user's credentials. Revokes all existing sessions. */
export async function setCredentials(db: DB, username: string, password: string) {
  if (!username.trim()) throw new Error("username must not be empty");
  if (password.length < 8) throw new Error("password must be at least 8 characters");
  const hash = await Bun.password.hash(password);
  db.transaction(() => {
    setSetting(db, "username", username.trim());
    setSetting(db, "password_hash", hash);
    db.query("DELETE FROM tokens").run();
  })();
}

/**
 * Make the stored credentials match TINYRSS_USERNAME / TINYRSS_PASSWORD, if set. Intended for
 * container deployments where running the CLI is awkward. Only writes (and thereby logs out
 * all sessions) when something actually changed.
 */
export async function syncCredentialsFromEnv(
  db: DB,
  env: { username?: string; password?: string },
): Promise<"unset" | "unchanged" | "created" | "updated"> {
  if (!env.password) return "unset";
  const username = env.username?.trim() || getUsername(db) || "admin";
  if (!hasCredentials(db)) {
    await setCredentials(db, username, env.password);
    return "created";
  }
  const current = getUsername(db);
  const hash = getSetting(db, "password_hash")!;
  if (current === username && (await Bun.password.verify(env.password, hash).catch(() => false))) return "unchanged";
  await setCredentials(db, username, env.password);
  return "updated";
}

export async function verifyCredentials(db: DB, username: string, password: string): Promise<boolean> {
  const user = getSetting(db, "username");
  const hash = getSetting(db, "password_hash");
  if (!user || !hash) return false;
  // Always verify the password so timing doesn't reveal whether the username matched.
  const ok = await Bun.password.verify(password, hash).catch(() => false);
  return ok && username.trim().toLowerCase() === user.toLowerCase();
}

export function createToken(db: DB, kind: TokenKind, label?: string): string {
  const token = randomHex(32);
  db.query("INSERT INTO tokens (hash, kind, label, created_at) VALUES (?, ?, ?, ?)").run(
    sha256(token),
    kind,
    label ?? null,
    Date.now(),
  );
  return token;
}

export function checkToken(db: DB, kind: TokenKind, token: string | undefined | null): boolean {
  if (!token) return false;
  const hash = sha256(token);
  const row = db.query("SELECT last_used_at FROM tokens WHERE hash = ? AND kind = ?").get(hash, kind) as {
    last_used_at: number | null;
  } | null;
  if (!row) return false;
  const now = Date.now();
  // Avoid a write on every request.
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    db.query("UPDATE tokens SET last_used_at = ? WHERE hash = ?").run(now, hash);
  }
  return true;
}

export function revokeToken(db: DB, token: string) {
  db.query("DELETE FROM tokens WHERE hash = ?").run(sha256(token));
}

export function revokeAllTokens(db: DB, kind?: TokenKind): number {
  return kind
    ? db.query("DELETE FROM tokens WHERE kind = ?").run(kind).changes
    : db.query("DELETE FROM tokens").run().changes;
}

export function listTokens(db: DB) {
  return db.query("SELECT kind, label, created_at, last_used_at FROM tokens ORDER BY created_at").all() as {
    kind: TokenKind;
    label: string | null;
    created_at: number;
    last_used_at: number | null;
  }[];
}

/** The GReader "T" (action) token, derived from the auth token so it needs no storage. */
export function postToken(db: DB, authToken: string): string {
  return new Bun.CryptoHasher("sha256", secret(db)).update(authToken).digest("hex").slice(0, 57);
}
