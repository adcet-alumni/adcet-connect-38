import { Router, raw } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import { uploadLimiter } from "../../middlewares/rateLimit.js";
import * as ctrl from "./uploads.controller.js";
import { downloadSchema, presignSchema } from "./uploads.validators.js";

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

uploadsRouter.post("/presign", uploadLimiter, validate(presignSchema), asyncHandler(ctrl.presignUpload));
uploadsRouter.post(
  "/direct",
  uploadLimiter,
  validate(presignSchema, "query"),
  raw({ type: "*/*", limit: "25mb" }),
  asyncHandler(ctrl.uploadDirect),
);
uploadsRouter.post("/presign-download", validate(downloadSchema), asyncHandler(ctrl.presignDownload));
uploadsRouter.delete("/", validate(downloadSchema), asyncHandler(ctrl.remove));
