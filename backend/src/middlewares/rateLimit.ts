/**
 * Rate limiters. Two profiles: a strict one for auth endpoints, a permissive
 * global one for everything else.
 */
import rateLimit from "express-rate-limit";
import { RATE_LIMITS } from "../config/constants.js";

// Supertest fires every request from one IP, so limits meant for real clients
// would trip mid-suite. Skip counting entirely under NODE_ENV=test.
const isTest = () => process.env.NODE_ENV === "test";

export const globalLimiter = rateLimit({
  windowMs: RATE_LIMITS.GLOBAL_WINDOW_MS,
  max: RATE_LIMITS.GLOBAL_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: isTest,
});

const createAuthLimiter = () => rateLimit({
  windowMs: RATE_LIMITS.AUTH_WINDOW_MS,
  max: RATE_LIMITS.AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "TOO_MANY_REQUESTS", message: "Too many auth attempts, slow down." } },
  skip: isTest,
});

/** Login attempts get their own bucket so they cannot block registration or recovery. */
export const loginLimiter = createAuthLimiter();
export const authLimiter = createAuthLimiter();