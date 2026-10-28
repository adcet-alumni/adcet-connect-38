import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { requireAuth } from "../../middlewares/auth.js";
import { requireAdmin } from "../../middlewares/rbac.js";
import { validate } from "../../middlewares/validate.js";
import * as ctrl from "./board.controller.js";
import { memberInputSchema, memberUpdateSchema, reorderSchema } from "./board.validators.js";

export const boardRouter = Router();

/* Public read — anyone can see the current board. */
boardRouter.get("/", asyncHandler(ctrl.listMembers));

/* Admin write — all mutations require an admin session. */
boardRouter.post("/", requireAuth, requireAdmin, validate(memberInputSchema), asyncHandler(ctrl.createMember));
boardRouter.patch("/:id", requireAuth, requireAdmin, validate(memberUpdateSchema), asyncHandler(ctrl.updateMember));
boardRouter.delete("/:id", requireAuth, requireAdmin, asyncHandler(ctrl.deleteMember));
boardRouter.post("/reorder", requireAuth, requireAdmin, validate(reorderSchema), asyncHandler(ctrl.reorderMembers));
