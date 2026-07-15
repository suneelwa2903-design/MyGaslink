import bcrypt from 'bcryptjs';
import crypto, { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import { sendOtpEmail, sendPasswordChangedEmail, sendPasswordResetConfirmationEmail } from '../utils/email.js';
import { logger } from '../utils/logger.js';
import type { AuthTokens, JwtPayload, UserProfile } from '@gaslink/shared';

// Group DPDP (2026-06-11): per-attempt login_history writes.
//
// Every login attempt (success + failure) and every password reset
// gets one row so a tenant admin can answer "who accessed this
// account, from which IP, and when". Required by DPDP §43.
//
// Writes are fire-and-forget — a row that fails to persist must never
// block the auth response. On failure, the helper logs to Winston and
// returns. userId is NULLABLE in the schema so a brute-force attempt
// against an unknown email still produces a row (failReason carries
// the attempted email for forensic correlation).
export type LoginHistoryFailReason =
  | 'USER_NOT_FOUND'
  | 'INVALID_PASSWORD'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_INACTIVE'
  | 'PASSWORD_RESET';
export interface LoginHistoryContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}
async function recordLoginAttempt(args: {
  userId: string | null;
  distributorId: string | null;
  success: boolean;
  failReason?: LoginHistoryFailReason | string | null;
  ctx?: LoginHistoryContext;
}) {
  try {
    await prisma.loginHistory.create({
      data: {
        userId: args.userId,
        distributorId: args.distributorId,
        success: args.success,
        failReason: args.failReason ?? null,
        ipAddress: args.ctx?.ipAddress ?? null,
        userAgent: args.ctx?.userAgent ?? null,
      },
    });
  } catch (err) {
    logger.warn('login_history write failed', { err: (err as Error).message });
  }
}

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateTokens(payload: JwtPayload): AuthTokens {
  const accessToken = jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiresIn,
  });
  // 2026-06-21: add a per-issuance JWT ID (RFC 7519 §4.1.7) so two refresh
  // tokens issued within the same second for the same user are guaranteed
  // to be distinct strings. Without this, a rapid login → refresh sequence
  // could produce identical JWTs (same iat + payload + secret), defeating
  // server-side rotation invalidation. Real users never hit the 1-second
  // collision but the security guarantee should not depend on that.
  const refreshToken = jwt.sign(
    { ...payload, jti: randomUUID() },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiresIn },
  );
  return { accessToken, refreshToken };
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwt.refreshSecret) as JwtPayload;
}

// Item 4 (2026-07-09) — multi-device refresh token storage helpers. Every
// login creates one row in `refresh_token_sessions`; every refresh finds
// the matching row for the presenting token, updates its hash, and stamps
// `last_used_at`. See docs/INVESTIGATION-JUL09-B.md item 4. The
// `User.refreshToken` column stays wired for the compatibility window —
// we WRITE it on login/refresh/logout/changePassword so any consumer that
// still reads it (there shouldn't be any post-cutover) sees a coherent
// last-known-good value. Reads happen from `refresh_token_sessions` only.

const REFRESH_TOKEN_SESSION_TTL_DAYS = 180;
const SESSION_CLEANUP_KEEP_DAYS = 30;

// Item 4 hash choice — SHA-256, NOT bcrypt. bcrypt truncates input to
// 72 bytes; two JWTs for the same user share their first ~150 chars
// (identical header + payload prefix), differing only in jti/iat/sig
// past byte ~180. That collides the bcrypt fingerprint and lets Device
// B's session incorrectly match Device A's token (verified in test
// 2026-07-09). SHA-256 has no truncation, is deterministic (so we can
// index-lookup directly instead of scanning candidates), and gives the
// same "DB-dump can't reveal raw token" guarantee — refresh tokens are
// already high-entropy JWTs so we don't need bcrypt's slow-hash defence
// against dictionary attacks.
function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createRefreshTokenSession(opts: {
  userId: string;
  refreshToken: string;
  deviceLabel?: string | null;
}): Promise<void> {
  const tokenHash = hashRefreshToken(opts.refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshTokenSession.create({
    data: {
      userId: opts.userId,
      tokenHash,
      deviceLabel: opts.deviceLabel ?? null,
      expiresAt,
      lastUsedAt: new Date(),
    },
  });
}

// SHA-256 is deterministic, so we can find directly by hash — cheaper
// than iterating every session for the user.
async function findMatchingRefreshSession(userId: string, presentedToken: string) {
  const tokenHash = hashRefreshToken(presentedToken);
  return prisma.refreshTokenSession.findFirst({
    where: {
      userId,
      tokenHash,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
}

async function cleanupOldRefreshSessions(userId: string): Promise<void> {
  const cutoff = new Date(Date.now() - SESSION_CLEANUP_KEEP_DAYS * 24 * 60 * 60 * 1000);
  try {
    await prisma.refreshTokenSession.deleteMany({
      where: {
        userId,
        OR: [
          { expiresAt: { lt: new Date() } },
          { revokedAt: { lt: cutoff } },
        ],
      },
    });
  } catch (err) {
    // Non-blocking — cleanup is best-effort.
    logger.warn('refresh_token_sessions cleanup failed', { err: (err as Error).message, userId });
  }
}

export async function login(
  email: string,
  password: string,
  ctx?: LoginHistoryContext,
  deviceLabel?: string | null,
): Promise<{ tokens: AuthTokens; user: UserProfile }> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    include: { distributor: { select: { businessName: true } } },
  });

  if (!user) {
    // Group DPDP: record the attempt even when the user doesn't exist
    // (userId stays null; we put the attempted email in failReason for
    // forensic correlation against the IP).
    void recordLoginAttempt({
      userId: null,
      distributorId: null,
      success: false,
      failReason: `USER_NOT_FOUND:${email.toLowerCase()}`,
      ctx,
    });
    throw new AuthError('Invalid email or password', 401);
  }

  // Check lockout
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    void recordLoginAttempt({
      userId: user.id, distributorId: user.distributorId, success: false, failReason: 'ACCOUNT_LOCKED', ctx,
    });
    const minutesRemaining = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
    throw new AuthError(`Account locked. Try again in ${minutesRemaining} minutes.`, 429);
  }

  if (user.status === 'suspended') {
    // Group L3 (2026-06-11): specialised message so the user knows to
    // contact their admin (not assume it's just a deactivated stale
    // account). Behaviour-equivalent — both branches reject login with
    // 403; the wording is what changes.
    void recordLoginAttempt({
      userId: user.id, distributorId: user.distributorId, success: false, failReason: 'ACCOUNT_SUSPENDED', ctx,
    });
    throw new AuthError(
      'Your account has been suspended. Contact your administrator.',
      403,
    );
  }
  if (user.status !== 'active') {
    void recordLoginAttempt({
      userId: user.id, distributorId: user.distributorId, success: false, failReason: 'ACCOUNT_INACTIVE', ctx,
    });
    throw new AuthError('Account is inactive or suspended', 403);
  }

  const passwordValid = await verifyPassword(password, user.passwordHash);
  if (!passwordValid) {
    // Increment login attempts
    const attempts = user.loginAttempts + 1;
    const lockout = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;

    await prisma.user.update({
      where: { id: user.id },
      data: { loginAttempts: attempts, lockedUntil: lockout },
    });

    void recordLoginAttempt({
      userId: user.id, distributorId: user.distributorId, success: false, failReason: 'INVALID_PASSWORD', ctx,
    });
    throw new AuthError('Invalid email or password', 401);
  }

  // Successful login — reset attempts, update last login, store refresh token
  const jwtPayload: JwtPayload = {
    userId: user.id,
    email: user.email,
    role: user.role as JwtPayload['role'],
    distributorId: user.distributorId,
    customerId: user.customerId,
    // Feature A (2026-07-15): customer_hq logins carry groupId so the
    // group-portal middleware can resolve visible customer ids without
    // a second DB round-trip. Null for every other role.
    groupId: user.groupId,
  };

  const tokens = generateTokens(jwtPayload);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      loginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      // Item 4 — kept for the compatibility window; readers moved to
      // refresh_token_sessions. Safe to drop after all clients cut over.
      refreshToken: tokens.refreshToken,
    },
  });

  // Item 4 — record this device as a live refresh session.
  await createRefreshTokenSession({
    userId: user.id,
    refreshToken: tokens.refreshToken,
    deviceLabel,
  });
  // Fire-and-forget cleanup of dead sessions for this user.
  void cleanupOldRefreshSessions(user.id);

  void recordLoginAttempt({
    userId: user.id, distributorId: user.distributorId, success: true, ctx,
  });

  const profile: UserProfile = {
    userId: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    role: user.role as UserProfile['role'],
    status: user.status as UserProfile['status'],
    distributorId: user.distributorId,
    distributorName: user.distributor?.businessName ?? null,
    customerId: user.customerId,
    requiresPasswordReset: user.requiresPasswordReset,
  };

  return { tokens, user: profile };
}

export async function refreshTokens(refreshToken: string): Promise<AuthTokens> {
  const payload = verifyRefreshToken(refreshToken);

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: { id: true, status: true, email: true, role: true, distributorId: true, customerId: true, groupId: true },
  });

  if (!user || user.status !== 'active') {
    throw new AuthError('Invalid refresh token', 401);
  }

  // Item 4 — read from refresh_token_sessions instead of the single-slot
  // User.refreshToken column. bcrypt.compare each candidate row for this
  // user (tokenHash is salted so a direct index lookup is not possible).
  // Realistic session counts per user are ≤ 3 devices, so the scan is
  // cheap.
  const session = await findMatchingRefreshSession(user.id, refreshToken);
  if (!session) {
    throw new AuthError('Invalid refresh token', 401);
  }

  const newPayload: JwtPayload = {
    userId: user.id,
    email: user.email,
    role: user.role as JwtPayload['role'],
    distributorId: user.distributorId,
    customerId: user.customerId,
    // Feature A (2026-07-15): re-attach groupId on every refresh so
    // customer_hq logins survive token rotation cleanly.
    groupId: user.groupId,
  };

  const tokens = generateTokens(newPayload);
  const newHash = hashRefreshToken(tokens.refreshToken);

  // Rotate this session's tokenHash (invalidates the presented token).
  await prisma.refreshTokenSession.update({
    where: { id: session.id },
    data: {
      tokenHash: newHash,
      lastUsedAt: new Date(),
    },
  });

  // Backward compat — mirror the newest token onto User.refreshToken so
  // any legacy reader sees the current value. Safe to drop post-cutover.
  await prisma.user.update({
    where: { id: user.id },
    data: { refreshToken: tokens.refreshToken },
  });

  return tokens;
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, email: true, firstName: true, lastName: true },
  });

  if (!user) throw new AuthError('User not found', 404);

  const valid = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) throw new AuthError('Current password is incorrect', 401);

  const newHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: newHash,
      requiresPasswordReset: false,
      refreshToken: null,
    },
  });
  // Item 4 — force re-login on ALL devices. Same security intent as the
  // pre-Item-4 `refreshToken: null` above (which now only clears the
  // legacy single-slot slot), extended to every live session in the new
  // table. Cascade delete on User handles this via schema but we're
  // explicit here for clarity.
  await prisma.refreshTokenSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // Group B Part 6 — fire-and-forget security notification. The sender
  // never throws, so an SMTP outage cannot break the password change
  // itself; an audit row lands in email_logs regardless of outcome.
  void sendPasswordChangedEmail({
    to: user.email,
    name: `${user.firstName} ${user.lastName}`.trim(),
    changedAt: new Date(),
    userId,
  });
}

export async function logout(userId: string, refreshToken?: string): Promise<void> {
  // Item 4 — when the caller presents its refresh token, revoke ONLY
  // that session so other devices stay logged in. When no token is
  // presented (legacy callers), fall back to the pre-Item-4 behaviour
  // of clearing the single-slot User.refreshToken but DO NOT revoke
  // sibling sessions — that would regress the multi-device fix.
  if (refreshToken) {
    const session = await findMatchingRefreshSession(userId, refreshToken);
    if (session) {
      await prisma.refreshTokenSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date() },
      });
    }
  }
  await prisma.user.update({
    where: { id: userId },
    data: { refreshToken: null },
  });
}

// ─── Forgot Password Flow ────────────────────────────────────────────────────

const OTP_EXPIRY_MINUTES = 10;
const RESET_TOKEN_EXPIRY = '5m';

function generateOtp(): string {
  // Cryptographically random 6-digit OTP
  return String(crypto.randomInt(100000, 999999));
}

/**
 * Step 1: Request password reset. Looks up by email first, then phone.
 * Sends OTP to the user's registered email.
 */
export async function forgotPassword(identifier: string): Promise<void> {
  const normalized = identifier.trim().toLowerCase();

  // Look up by email first, then by phone
  let user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) {
    user = await prisma.user.findFirst({ where: { phone: normalized } });
  }

  if (!user) {
    // Don't reveal whether user exists — silently return
    return;
  }

  if (user.status !== 'active') {
    // Don't reveal account status
    return;
  }

  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      resetOtp: otpHash,
      resetOtpExpiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
    },
  });

  // Send OTP email
  const userName = `${user.firstName} ${user.lastName}`.trim() || 'User';
  await sendOtpEmail(user.email, otp, userName);
}

/**
 * Step 2: Verify OTP and return a short-lived reset token.
 */
export async function verifyResetOtp(identifier: string, otp: string): Promise<string> {
  const normalized = identifier.trim().toLowerCase();

  let user = await prisma.user.findUnique({ where: { email: normalized } });
  if (!user) {
    user = await prisma.user.findFirst({ where: { phone: normalized } });
  }

  if (!user || !user.resetOtp || !user.resetOtpExpiresAt) {
    throw new AuthError('Invalid or expired OTP', 400);
  }

  // Check expiry
  if (user.resetOtpExpiresAt < new Date()) {
    // Clear expired OTP
    await prisma.user.update({
      where: { id: user.id },
      data: { resetOtp: null, resetOtpExpiresAt: null },
    });
    throw new AuthError('OTP has expired. Please request a new one.', 400);
  }

  // Verify OTP hash
  const valid = await bcrypt.compare(otp, user.resetOtp);
  if (!valid) {
    throw new AuthError('Invalid or expired OTP', 400);
  }

  // Generate a short-lived reset token
  const resetToken = jwt.sign(
    { userId: user.id, purpose: 'password-reset' },
    config.jwt.accessSecret,
    { expiresIn: RESET_TOKEN_EXPIRY },
  );

  return resetToken;
}

/**
 * Step 3: Reset password using the short-lived reset token.
 */
export async function resetPassword(resetToken: string, newPassword: string): Promise<void> {
  let payload: { userId: string; purpose: string };
  try {
    payload = jwt.verify(resetToken, config.jwt.accessSecret) as { userId: string; purpose: string };
  } catch {
    throw new AuthError('Invalid or expired reset token', 400);
  }

  if (payload.purpose !== 'password-reset') {
    throw new AuthError('Invalid reset token', 400);
  }

  const user = await prisma.user.findUnique({ where: { id: payload.userId } });
  if (!user) {
    throw new AuthError('User not found', 404);
  }

  const newHash = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: newHash,
      resetOtp: null,
      resetOtpExpiresAt: null,
      requiresPasswordReset: false,
      refreshToken: null,
      loginAttempts: 0,
      lockedUntil: null,
    },
  });
  // Item 4 (2026-07-09) — force logout on ALL devices after password reset,
  // matching changePassword's semantics.
  await prisma.refreshTokenSession.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // Group B Part 6 — fire-and-forget reset-complete notification. Same
  // never-throw guarantee as changePassword; an SMTP outage cannot
  // strand the password in a half-reset state.
  void sendPasswordResetConfirmationEmail({
    to: user.email,
    name: `${user.firstName} ${user.lastName}`.trim(),
    resetAt: new Date(),
    userId: user.id,
  });

  // Group DPDP (2026-06-11): mark the reset itself in login_history so
  // a tenant admin can see "this account had its password reset on
  // this date" alongside actual login events. success=true (the reset
  // itself succeeded) + failReason='PASSWORD_RESET' disambiguates it
  // from a regular login.
  void recordLoginAttempt({
    userId: user.id, distributorId: user.distributorId, success: true, failReason: 'PASSWORD_RESET',
  });
}

// ─── Custom Error ────────────────────────────────────────────────────────────

export class AuthError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'AuthError';
  }
}
