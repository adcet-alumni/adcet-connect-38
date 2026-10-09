/**
 * The document lists exist twice — the API validates the bytes against one, the
 * sign-up form offers the other — so this is what stops them drifting. A type
 * the picker accepts but the API rejects is an applicant uploading a file, then
 * being refused at the end of a long form.
 */
import { describe, expect, it } from "@jest/globals";
import {
  IDENTITY_DOCUMENT_KINDS,
  IDENTITY_DOCUMENT_MIME_TYPES,
} from "../../config/constants.js";
import {
  IDENTITY_ACCEPT,
  IDENTITY_DOCUMENT_KINDS as FRONTEND_KINDS,
  IDENTITY_DOCUMENT_MIME_TYPES as FRONTEND_TYPES,
  identityDocumentList,
} from "../../../../src/lib/identity.js";

describe("identity document lists", () => {
  it("offers exactly the kinds the copy promises", () => {
    expect([...FRONTEND_KINDS]).toEqual([...IDENTITY_DOCUMENT_KINDS]);
  });

  it("accepts exactly the types the API will take", () => {
    expect([...FRONTEND_TYPES]).toEqual([...IDENTITY_DOCUMENT_MIME_TYPES]);
    // The picker's `accept` attribute must not be wider than the server check.
    expect(IDENTITY_ACCEPT.split(",")).toEqual([...IDENTITY_DOCUMENT_MIME_TYPES]);
  });

  it("reads as a sentence", () => {
    expect(identityDocumentList()).toBe(
      "Library card, marksheet, leaving certificate or degree certificate",
    );
  });
});
