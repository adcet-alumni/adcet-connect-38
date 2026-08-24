/**
 * The byline of an achievement, and the icon beside it.
 *
 * Two cases have to work at once: an alumnus's own submission, bylined by
 * their account, and one the alumni office recorded for somebody who never
 * registered — where the row is owned by an admin and `achieverName` is the
 * only true name on it. Reading `user` alone bylines those "Admin User".
 *
 * The link is decided by the API, so the only rule here is: render it when one
 * arrived and is safe to render, and otherwise render nothing at all. A missing
 * LinkedIn is the ordinary case, never an error to show.
 */
import { describe, expect, it } from "vitest";
import { achieverInitials, achieverLinkedin, achieverOf } from "@/lib/achievements";

const member = {
  user: { firstName: "Asha", lastName: "Kulkarni" },
  linkedinUrl: "https://www.linkedin.com/in/asha",
};

const recordedByOffice = {
  achieverName: "Dr. S. R. Kulkarni",
  // The row belongs to the admin who filed it.
  user: { firstName: "Admin", lastName: "User" },
  linkedinUrl: "https://www.linkedin.com/in/srk",
};

describe("achieverOf", () => {
  it("bylines an alumnus's own submission with their account name", () => {
    expect(achieverOf(member)).toBe("Asha Kulkarni");
  });

  it("bylines an office-recorded entry with the achiever, not the admin who filed it", () => {
    expect(achieverOf(recordedByOffice)).toBe("Dr. S. R. Kulkarni");
  });

  it("ignores a blank achiever name rather than printing an empty byline", () => {
    expect(achieverOf({ achieverName: "   ", user: { firstName: "Asha", lastName: "K" } })).toBe(
      "Asha K",
    );
  });

  it("falls back when there is no name at all", () => {
    expect(achieverOf({})).toBe("Alumnus");
    expect(achieverOf({}, "Alumni")).toBe("Alumni");
  });
});

describe("achieverInitials", () => {
  it("takes them from whichever name the byline uses", () => {
    expect(achieverInitials(member)).toBe("AK");
    expect(achieverInitials(recordedByOffice)).toBe("DS");
  });

  it("never renders an empty bubble", () => {
    expect(achieverInitials({})).toBe("A");
  });
});

describe("achieverLinkedin", () => {
  it("passes a real link through", () => {
    expect(achieverLinkedin(member)).toBe("https://www.linkedin.com/in/asha");
  });

  it("is undefined when the API sent none — the icon is simply not drawn", () => {
    // null: the achiever has no link, or hid it. undefined: a public payload,
    // which never carries one. Neither is an error.
    expect(achieverLinkedin({ linkedinUrl: null })).toBeUndefined();
    expect(achieverLinkedin({})).toBeUndefined();
    expect(achieverLinkedin({ linkedinUrl: "" })).toBeUndefined();
  });

  it("refuses a link that is not http(s), however it got stored", () => {
    expect(achieverLinkedin({ linkedinUrl: "javascript:alert(1)" })).toBeUndefined();
  });
});
