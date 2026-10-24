import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middlewares/auth.js";
import { requireAdmin } from "../../middlewares/rbac.js";
import { validate } from "../../middlewares/validate.js";
import * as ctrl from "./esteemed.controller.js";
import {
  alumnusInputSchema,
  alumnusUpdateSchema,
  listQuerySchema,
  reorderSchema,
} from "./esteemed.validators.js";

export const esteemedRouter = Router();

/* Public read — anyone can see the esteemed alumni roster. */
esteemedRouter.get("/", validate(listQuerySchema, "query"), asyncHandler(ctrl.listAlumni));

/* Admin write — all mutations require an admin session. */
esteemedRouter.post("/", requireAuth, requireAdmin, validate(alumnusInputSchema), asyncHandler(ctrl.createAlumnus));
esteemedRouter.patch("/:id", requireAuth, requireAdmin, validate(alumnusUpdateSchema), asyncHandler(ctrl.updateAlumnus));
esteemedRouter.delete("/:id", requireAuth, requireAdmin, asyncHandler(ctrl.deleteAlumnus));
esteemedRouter.post("/reorder", requireAuth, requireAdmin, validate(reorderSchema), asyncHandler(ctrl.reorderAlumni));
