import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middlewares/auth.js";
import { requireAdmin } from "../../middlewares/rbac.js";
import { requireApproved } from "../../middlewares/requireApproved.js";
import { validate } from "../../middlewares/validate.js";
import * as ctrl from "./donations.controller.js";
import {
  approveDonationSchema,
  campaignInputSchema,
  listCampaignsQuery,
  donationStatsQuery,
  listDonationsQuery,
  rejectDonationSchema,
  submitDonationSchema,
  topDonorsQuery,
} from "./donations.validators.js";

export const donationsRouter = Router();

// Top donors — PUBLIC (no auth): the honour roll on the landing page. Returns
// names, lifetime totals and avatars only, for donors who did **not** give
// anonymously; see `topDonors()` for the three rules that keep it publishable.
donationsRouter.get(
  "/public/top-donors",
  validate(topDonorsQuery, "query"),
  asyncHandler(ctrl.topDonors),
);

// Campaigns (member read, admin write)
donationsRouter.get(
  "/campaigns",
  requireAuth,
  requireApproved,
  validate(listCampaignsQuery, "query"),
  asyncHandler(ctrl.listCampaigns),
);
donationsRouter.get("/campaigns/:id", requireAuth, requireApproved, asyncHandler(ctrl.getCampaign));
donationsRouter.post(
  "/campaigns",
  requireAuth,
  requireAdmin,
  validate(campaignInputSchema),
  asyncHandler(ctrl.createCampaign),
);
donationsRouter.patch(
  "/campaigns/:id",
  requireAuth,
  requireAdmin,
  validate(campaignInputSchema.partial()),
  asyncHandler(ctrl.updateCampaign),
);
donationsRouter.delete(
  "/campaigns/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(ctrl.deleteCampaign),
);

/*
 * Donations — pay off-portal, declare, then wait for the office.
 *
 * There is no gateway callback and no webhook to receive one: `POST /` files
 * what the donor says they paid, and nothing but an admin's `approve` turns it
 * into money. `payment-details` is what the donor pays *against*, so it is
 * behind the same member gate as the form itself.
 */
donationsRouter.get(
  "/payment-details",
  requireAuth,
  requireApproved,
  asyncHandler(ctrl.paymentDetails),
);
donationsRouter.post(
  "/",
  requireAuth,
  requireApproved,
  validate(submitDonationSchema),
  asyncHandler(ctrl.submit),
);
donationsRouter.get("/me", requireAuth, requireApproved, asyncHandler(ctrl.myDonations));
// A donor withdrawing their own submission — only while it is still PLEDGED.
donationsRouter.post("/:id/withdraw", requireAuth, requireApproved, asyncHandler(ctrl.cancelOwn));

// The alumni office's side: the ledger, its totals, and the two decisions.
// `/stats` is declared before `/:id/...` for clarity, not necessity — it is a
// GET on a distinct path.
donationsRouter.get(
  "/stats",
  requireAuth,
  requireAdmin,
  validate(donationStatsQuery, "query"),
  asyncHandler(ctrl.donationStats),
);
donationsRouter.get(
  "/",
  requireAuth,
  requireAdmin,
  validate(listDonationsQuery, "query"),
  asyncHandler(ctrl.listDonations),
);
donationsRouter.post(
  "/:id/approve",
  requireAuth,
  requireAdmin,
  validate(approveDonationSchema),
  asyncHandler(ctrl.approve),
);
donationsRouter.post(
  "/:id/reject",
  requireAuth,
  requireAdmin,
  validate(rejectDonationSchema),
  asyncHandler(ctrl.reject),
);
