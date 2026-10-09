/**
 * The payment-method list exists twice — the API validates against it, the
 * donation form renders it — so this is what stops the two copies from
 * drifting. A method the form offers but the API rejects is a donor filling in
 * a long form and getting a 400 on submit.
 */
import { describe, expect, it } from "@jest/globals";
import { DONATION_PAYMENT_METHODS } from "../../config/constants.js";
import { DONATION_PAYMENT_METHODS as FRONTEND_METHODS } from "../../../../src/lib/donations.js";
import { submitDonationSchema } from "../../modules/donations/donations.validators.js";

describe("DONATION_PAYMENT_METHODS", () => {
  it("is the same list the donation form offers", () => {
    expect([...FRONTEND_METHODS]).toEqual([...DONATION_PAYMENT_METHODS]);
  });

  it("is the list the API accepts, and nothing else", () => {
    const body = (over: Record<string, unknown> = {}) => ({
      amount: 500,
      reference: "UTR12345678",
      paymentMethod: "UPI",
      paidAt: new Date().toISOString(),
      ...over,
    });
    for (const method of DONATION_PAYMENT_METHODS) {
      expect(submitDonationSchema.safeParse(body({ paymentMethod: method })).success).toBe(true);
    }
    expect(submitDonationSchema.safeParse(body({ paymentMethod: "BITCOIN" })).success).toBe(false);
  });
});
