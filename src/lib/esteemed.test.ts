/**
 * The esteemed alumni roster is now DB-backed and admin-managed.
 * The old static file tests are replaced by:
 *  - API integration tests in `backend/src/tests/integration/`
 *  - The frontend lib (`esteemed.ts`) now exports API wrappers rather than
 *    static data, so there is no static array to validate here.
 *
 * These tests verify only the utility helpers that remain in `esteemed.ts`.
 */
import { describe, expect, it } from "vitest";
import { categoryIdOf, ESTEEMED_CATEGORIES } from "./esteemed";

describe("esteemed helpers", () => {
  it("categoryIdOf maps DB enum values to UI ids", () => {
    expect(categoryIdOf("leadership")).toBe("leadership");
    expect(categoryIdOf("entrepreneurs")).toBe("entrepreneurs");
    expect(categoryIdOf("civil_services")).toBe("civil-services");
  });

  it("ESTEEMED_CATEGORIES covers all three categories", () => {
    expect(ESTEEMED_CATEGORIES).toHaveLength(3);
    const ids = ESTEEMED_CATEGORIES.map((c) => c.id);
    expect(ids).toContain("leadership");
    expect(ids).toContain("entrepreneurs");
    expect(ids).toContain("civil-services");
  });

  it("every category has a title and description", () => {
    for (const cat of ESTEEMED_CATEGORIES) {
      expect(cat.title.trim()).not.toBe("");
      expect(cat.description.trim()).not.toBe("");
      expect(cat.dbValue).toBeDefined();
    }
  });
});
