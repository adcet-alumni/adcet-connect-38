/**
 * The pool settings Prisma reads out of the connection string.
 *
 * Prisma takes `connection_limit` and `pool_timeout` from the URL and nowhere
 * else, and defaults the limit to `num_physical_cpus * 2 + 1` — so an unpinned
 * pool changes size with the container's CPU allocation. `withPoolSettings`
 * fills those in, and the one rule that matters is that it never overrides a
 * value an operator put there deliberately.
 */
import { describe, expect, it } from "@jest/globals";
import { withPoolSettings } from "../../lib/prisma.js";
import { env } from "../../config/env.js";

const params = (url: string) => new URL(url).searchParams;

describe("withPoolSettings", () => {
  it("pins the pool size when the URL says nothing about it", () => {
    const p = params(withPoolSettings("postgresql://u:p@localhost:5432/db"));
    expect(p.get("connection_limit")).toBe(String(env.DATABASE_CONNECTION_LIMIT));
    expect(p.get("pool_timeout")).toBe(String(env.DATABASE_POOL_TIMEOUT));
  });

  it("leaves an operator's own values alone", () => {
    const p = params(
      withPoolSettings("postgresql://u:p@localhost:5432/db?connection_limit=3&pool_timeout=2"),
    );
    expect(p.get("connection_limit")).toBe("3");
    expect(p.get("pool_timeout")).toBe("2");
  });

  it("keeps the parameters already on the URL, such as ?schema=", () => {
    const p = params(withPoolSettings("postgresql://u:p@localhost:5432/db?schema=public"));
    expect(p.get("schema")).toBe("public");
    expect(p.get("connection_limit")).toBe(String(env.DATABASE_CONNECTION_LIMIT));
  });

  it("passes an unparseable URL straight through for Prisma to reject", () => {
    expect(withPoolSettings("not a url")).toBe("not a url");
  });
});
