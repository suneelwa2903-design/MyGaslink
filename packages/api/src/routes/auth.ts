import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { loginSchema, changePasswordSchema, forgotPasswordSchema, verifyResetOtpSchema, resetPasswordSchema } from '@gaslink/shared';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';
import * as authService from '../services/authService.js';
import { logBusinessEvent } from '../utils/logger.js';
import { z } from 'zod';

// Pre-Razorpay security sweep (2026-06-12): the /refresh endpoint was
// the only auth route without a Zod gate. Pre-fix the handler did a
// manual `if (!refreshToken)` check; that's defensive but inconsistent
// and accepts arbitrary body shapes. Now matches the same validate(...)
// pattern every other auth route uses.
const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

const router = Router();

// Rate limit for login: relaxed in dev, strict in production
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many login attempts. Please try again later.', code: 'RATE_LIMITED' },
});

// Refresh-token endpoint is unauthenticated and accepts a body credential —
// rate-limit the same shape as login (per-IP, 15-min window). Keeps brute-force
// against captured refresh tokens infeasible.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 30 : 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many refresh attempts. Please try again later.', code: 'RATE_LIMITED' },
});

/**
 * POST /api/auth/login
 * Public — authenticate user with email + password
 */
router.post('/login', loginLimiter, validate(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;
    // Group DPDP (2026-06-11): pass IP + user-agent through to the
    // service so every login_history row is forensically useful.
    const result = await authService.login(email, password, {
      ipAddress: req.ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });

    logBusinessEvent({
      action: 'user.login',
      entityType: 'user',
      entityId: result.user.userId,
      requestId: req.requestId,
    });

    return sendSuccess(res, result);
  } catch (err) {
    if (err instanceof authService.AuthError) {
      return sendError(res, err.message, err.statusCode);
    }
    return sendError(res, 'Login failed');
  }
});

/**
 * POST /api/auth/refresh
 * Public — exchange refresh token for new token pair
 */
router.post('/refresh', refreshLimiter, validate(refreshSchema), async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const tokens = await authService.refreshTokens(refreshToken);
    return sendSuccess(res, { tokens });
  } catch (err) {
    if (err instanceof authService.AuthError) {
      return sendError(res, err.message, err.statusCode);
    }
    return sendError(res, 'Token refresh failed', 401);
  }
});

/**
 * POST /api/auth/change-password
 * Authenticated — change current user's password
 */
router.post('/change-password', authenticate, validate(changePasswordSchema), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    await authService.changePassword(req.user!.userId, currentPassword, newPassword);

    logBusinessEvent({
      action: 'user.password_changed',
      entityType: 'user',
      entityId: req.user!.userId,
      requestId: req.requestId,
    });

    return sendSuccess(res, { message: 'Password changed successfully' });
  } catch (err) {
    if (err instanceof authService.AuthError) {
      return sendError(res, err.message, err.statusCode);
    }
    return sendError(res, 'Password change failed');
  }
});

// Rate limit for forgot password: prevent abuse
const forgotPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 5 : 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
});

// Rate limit for reset password: same shape as forgotPasswordLimiter so an
// attacker who burns through the OTP-request budget can't pivot to brute-
// forcing valid reset tokens. The global 1000-req/15min cap (app.ts) is far
// too loose for a credential-changing endpoint. Per-IP, 15-min window,
// 5 attempts in production / 50 in non-prod for dev ergonomics.
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 5 : 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, data: null, error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' },
});

/**
 * POST /api/auth/forgot-password
 * Public — request password reset OTP
 */
router.post('/forgot-password', forgotPasswordLimiter, validate(forgotPasswordSchema), async (req, res) => {
  try {
    const { identifier } = req.body;
    await authService.forgotPassword(identifier);

    logBusinessEvent({
      action: 'user.forgot_password_requested',
      entityType: 'user',
      entityId: identifier,
      requestId: req.requestId,
    });

    // Always return success to prevent user enumeration
    return sendSuccess(res, { message: 'If an account exists with that email or phone, an OTP has been sent to the registered email.' });
  } catch {
    // Still return success to prevent enumeration
    return sendSuccess(res, { message: 'If an account exists with that email or phone, an OTP has been sent to the registered email.' });
  }
});

/**
 * POST /api/auth/verify-reset-otp
 * Public — verify OTP and get short-lived reset token
 */
router.post('/verify-reset-otp', forgotPasswordLimiter, validate(verifyResetOtpSchema), async (req, res) => {
  try {
    const { identifier, otp } = req.body;
    const resetToken = await authService.verifyResetOtp(identifier, otp);

    return sendSuccess(res, { resetToken });
  } catch (err) {
    if (err instanceof authService.AuthError) {
      return sendError(res, err.message, err.statusCode);
    }
    return sendError(res, 'OTP verification failed');
  }
});

/**
 * POST /api/auth/reset-password
 * Public — reset password using the short-lived token
 */
router.post('/reset-password', resetPasswordLimiter, validate(resetPasswordSchema), async (req, res) => {
  try {
    const { resetToken, newPassword } = req.body;
    await authService.resetPassword(resetToken, newPassword);

    logBusinessEvent({
      action: 'user.password_reset',
      entityType: 'user',
      entityId: 'reset-token-user',
      requestId: req.requestId,
    });

    return sendSuccess(res, { message: 'Password reset successfully. Please login with your new password.' });
  } catch (err) {
    if (err instanceof authService.AuthError) {
      return sendError(res, err.message, err.statusCode);
    }
    return sendError(res, 'Password reset failed');
  }
});

/**
 * POST /api/auth/logout
 * Authenticated — revoke refresh token
 */
router.post('/logout', authenticate, async (req, res) => {
  try {
    await authService.logout(req.user!.userId);
    return sendSuccess(res, { message: 'Logged out successfully' });
  } catch {
    return sendError(res, 'Logout failed');
  }
});

/**
 * GET /api/auth/me
 * Authenticated — get current user profile
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await import('../lib/prisma.js').then(m =>
      m.prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          phone: true, role: true, status: true, distributorId: true,
          customerId: true, requiresPasswordReset: true,
          distributor: { select: { businessName: true } },
        },
      })
    );

    if (!user) return sendError(res, 'User not found', 404);

    return sendSuccess(res, {
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      role: user.role,
      status: user.status,
      distributorId: user.distributorId,
      distributorName: user.distributor?.businessName ?? null,
      customerId: user.customerId,
      requiresPasswordReset: user.requiresPasswordReset,
    });
  } catch {
    return sendError(res, 'Failed to fetch profile');
  }
});

export default router;
