import type { Request, Response } from "express";
import * as service from "./auth.service.js";
import { Unauthorized } from "../../lib/errors.js";

export const sendRegistrationOtp = async (req: Request, res: Response) => {
  const { devCode } = await service.sendRegistrationOtp(req.body.email);
  res.status(202).json({
    message: devCode
      ? "Email delivery is unavailable — use the code below."
      : "A verification code has been sent to your email.",
    ...(devCode ? { devCode } : {}),
  });
};

export const register = async (req: Request, res: Response) => {
  const result = await service.register(req.body);
  res.status(201).json(result);
};

export const login = async (req: Request, res: Response) => {
  const result = await service.login(req.body);
  res.json(result);
};

export const refresh = async (req: Request, res: Response) => {
  const tokens = await service.refresh(req.body.refreshToken);
  res.json(tokens);
};

export const logout = async (req: Request, res: Response) => {
  await service.logout(req.body.refreshToken);
  res.status(204).end();
};

export const me = async (req: Request, res: Response) => {
  if (!req.auth) throw Unauthorized();
  const user = await service.me(req.auth.sub);
  res.json(user);
};

/** Onboarding safety net for accounts with an incomplete profile. */
export const completeProfile = async (req: Request, res: Response) => {
  if (!req.auth) throw Unauthorized();
  const user = await service.completeProfile(req.auth.sub, req.body);
  res.json(user);
};

export const forgotPassword = async (req: Request, res: Response) => {
  await service.forgotPassword(req.body.email);
  // Always 202 regardless of whether the email exists (no user enumeration).
  res.status(202).json({ message: "If an account exists for that email, a reset link has been sent." });
};
export const resetPassword = async (req: Request, res: Response) => {
  await service.resetPassword(req.body.token, req.body.newPassword);
  res.json({ message: "Your password has been reset. You can now sign in." });
};
export const changePassword = async (req: Request, res: Response) => {
  if (!req.auth) throw Unauthorized();
  await service.changePassword(req.auth.sub, req.body.currentPassword, req.body.newPassword);
  res.json({ message: "Password updated." });
};