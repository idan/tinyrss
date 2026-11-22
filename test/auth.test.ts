import { expect, test } from "bun:test";
import { checkToken, createToken, getUsername, syncCredentialsFromEnv, verifyCredentials } from "../src/auth.ts";
import { openDb } from "../src/db.ts";

test("syncCredentialsFromEnv", async () => {
  const db = openDb(":memory:");
  expect(await syncCredentialsFromEnv(db, {})).toBe("unset");

  expect(await syncCredentialsFromEnv(db, { password: "password-one" })).toBe("created");
  expect(getUsername(db)).toBe("admin");

  const token = createToken(db, "api");
  // restarting with the same settings changes nothing and keeps sessions
  expect(await syncCredentialsFromEnv(db, { username: "admin", password: "password-one" })).toBe("unchanged");
  expect(checkToken(db, "api", token)).toBe(true);

  // changing the password logs everyone out
  expect(await syncCredentialsFromEnv(db, { username: "admin", password: "password-two" })).toBe("updated");
  expect(checkToken(db, "api", token)).toBe(false);
  expect(await verifyCredentials(db, "admin", "password-two")).toBe(true);

  // renaming the user, keeping the password
  expect(await syncCredentialsFromEnv(db, { username: "me", password: "password-two" })).toBe("updated");
  expect(await verifyCredentials(db, "me", "password-two")).toBe(true);

  await expect(syncCredentialsFromEnv(db, { password: "short" })).rejects.toThrow("at least 8");
});
