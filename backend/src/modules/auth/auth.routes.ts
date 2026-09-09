import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { validate } from "../../middlewares/validate.js";
import { requireAuth } from "../../middlewares/auth.js";
import { authLimiter, loginLimiter } from "../../middlewares/rateLimit.js";
import * as ctrl from "./auth.controller.js";
import {
  changePasswordSchema,
  completeProfileSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  sendRegistrationOtpSchema,
} from "./auth.validators.js";

export const authRouter = Router();

authRouter.post("/register/send-otp", authLimiter, validate(sendRegistrationOtpSchema), asyncHandler(ctrl.sendRegistrationOtp));
authRouter.post("/register", authLimiter, validate(registerSchema), asyncHandler(ctrl.register));
authRouter.post("/login", loginLimiter, validate(loginSchema), asyncHandler(ctrl.login));
authRouter.post("/refresh", validate(refreshSchema), asyncHandler(ctrl.refresh));
authRouter.post("/logout", validate(refreshSchema), asyncHandler(ctrl.logout));
authRouter.get("/me", requireAuth, asyncHandler(ctrl.me));
// Onboarding safety net: registration collects every required field, so a
// complete-profile round trip is normally never needed. It stays for accounts
// created before that was true (and any imported by the office), which
// `ProtectedRoute` still funnels here rather than into a half-empty portal.
authRouter.post("/complete-profile", requireAuth, validate(completeProfileSchema), asyncHandler(ctrl.completeProfile));

authRouter.post("/forgot-password", authLimiter, validate(forgotPasswordSchema), asyncHandler(ctrl.forgotPassword));
authRouter.post("/reset-password", authLimiter, validate(resetPasswordSchema), asyncHandler(ctrl.resetPassword));
authRouter.post("/change-password", requireAuth, validate(changePasswordSchema), asyncHandler(ctrl.changePassword));
