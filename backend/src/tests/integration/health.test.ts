/**
 * Integration smoke test: validates that the full Express app boots inside
 * Jest's ESM VM with the Prisma module mocked, and that the unauthenticated
 * /health endpoint responds.
 *
 * If this test fails, every other integration test will too — start here.
 */
import { jest } from "@jest/globals";
import request from "supertest";
import { createPrismaDeepMock } from "../helpers/integrationApp.js";

const prisma = createPrismaDeepMock();
jest.unstable_mockModule("../../lib/prisma.js", () => ({ prisma }));

const { buildApp } = await import("../../app.js");
const app = buildApp();

describe("integration: health & 404", () => {
  it("GET /api/v1/health → 200 ok", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  /*
   * The two probes answer different questions, and conflating them is what the
   * split fixes: a single endpoint that returned 200 with the database down
   * kept a broken instance in the load balancer, while one that checked the
   * database from the liveness path would restart every replica during an
   * outage.
   */
  describe("liveness", () => {
    it("answers without touching the database", async () => {
      prisma.$queryRaw.mockRejectedValue(new Error("db is down"));

      const res = await request(app).get("/api/v1/health/live");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(typeof res.body.uptime).toBe("number");
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe("readiness", () => {
    it("200 ready when every dependency answers", async () => {
      prisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);

      const res = await request(app).get("/api/v1/health/ready");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready");
      expect(res.body.checks).toEqual({ database: "ok", storage: "ok" });
    });

    it("503 with the reason when the database is unreachable", async () => {
      // The bug this replaces: the old endpoint answered 200 here, so the
      // orchestrator kept routing traffic to an instance that could not serve it.
      prisma.$queryRaw.mockRejectedValue(new Error("connection refused"));

      const res = await request(app).get("/api/v1/health/ready");

      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unavailable");
      expect(res.body.checks.database).toBe("connection refused");
      // One failing dependency must not mask the state of the others.
      expect(res.body.checks.storage).toBe("ok");
    });
  });

  it("unknown route → 404 with structured error", async () => {
    const res = await request(app).get("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});