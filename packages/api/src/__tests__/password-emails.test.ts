import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../services/authService.js';
import type { Express } from 'express';

// Group B Part 6 — password-changed + password-reset-completed
// confirmation emails. Both notifications are fire-and-forget and write an
// email_logs row. The test SMTP harness (see __tests__/setup.ts) wipes
// SMTP_HOST/USER/PASS so every send goes down the 'skipped' branch; the
// audit row still lands so we can verify the wiring.

let app: Express;
const TEST_EMAIL = 'password-emails-test@example.com';
const ORIGINAL_PASSWORD = 'Original@1234';
let testUserId = '';

async function loginAs(password: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: TEST_EMAIL, password });
  if (res.status !== 200) {
    throw new Error(`login failed for ${TEST_EMAIL}: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.tokens.accessToken;
}

async function resetUserPasswordDirect(): Promise<void> {
  // Force-reset the password via a direct DB update so each test starts
  // from a known state regardless of the previous test's outcome. Avoids
  // the brittle multi-step API round-trip and the rate-limit/lockout
  // surface of the login endpoint.
  const passwordHash = await hashPassword(ORIGINAL_PASSWORD);
  await prisma.user.update({
    where: { id: testUserId },
    data: {
      passwordHash,
      loginAttempts: 0,
      lockedUntil: null,
      refreshToken: null,
      requiresPasswordReset: false,
    },
  });
}

beforeAll(async () => {
  app = createApp();
  await prisma.emailLog.deleteMany({ where: { toEmail: TEST_EMAIL } });
  await prisma.user.deleteMany({ where: { email: TEST_EMAIL } });
  const passwordHash = await hashPassword(ORIGINAL_PASSWORD);
  const user = await prisma.user.create({
    data: {
      email: TEST_EMAIL,
      passwordHash,
      firstName: 'Password',
      lastName: 'Tester',
      phone: '9100099900',
      role: 'finance',
      distributorId: 'dist-001',
      status: 'active',
      requiresPasswordReset: false,
    },
  });
  testUserId = user.id;
});

beforeEach(async () => {
  // Every test starts from the original password + zero email_logs rows
  // for the password-change subtree. This lets each test assert on
  // `toHaveLength(1)` without coordinating with siblings.
  await resetUserPasswordDirect();
  await prisma.emailLog.deleteMany({
    where: {
      toEmail: TEST_EMAIL,
      type: { in: ['password_changed', 'password_reset_otp', 'password_reset_completed'] },
    },
  });
});

afterAll(async () => {
  await prisma.emailLog.deleteMany({ where: { toEmail: TEST_EMAIL } });
  if (testUserId) {
    await prisma.user.deleteMany({ where: { id: testUserId } });
  }
});

describe('Password emails — change-password notification (Group B Part 6)', () => {
  it('writes an email_logs row when the user voluntarily changes their password', async () => {
    const token = await loginAs(ORIGINAL_PASSWORD);
    const NEW_PASSWORD = 'Updated@1234';
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    // void-ed sender — give the microtask queue a tick.
    await new Promise((r) => setTimeout(r, 50));

    const logs = await prisma.emailLog.findMany({
      where: { toEmail: TEST_EMAIL, type: 'password_changed' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('skipped'); // SMTP wiped in test setup
    expect(logs[0].errorText).toBe('SMTP not configured');
    expect(logs[0].userId).toBe(testUserId);
    expect(logs[0].subject).toBe('Your MyGasLink password was changed');
  });

  it('change-password failure (wrong current password) does NOT send the email', async () => {
    const token = await loginAs(ORIGINAL_PASSWORD);
    const NEW_PASSWORD = 'Updated@1234';
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'totally-wrong-password', newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).not.toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    const count = await prisma.emailLog.count({
      where: { toEmail: TEST_EMAIL, type: 'password_changed' },
    });
    expect(count).toBe(0);
  });
});

describe('Password emails — forgot-password / reset notification (Group B Part 6)', () => {
  it('forgot-password writes an OTP row (skipped, since test SMTP is wiped)', async () => {
    const forgot = await request(app)
      .post('/api/auth/forgot-password')
      .send({ identifier: TEST_EMAIL });
    expect(forgot.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    const otpLogs = await prisma.emailLog.findMany({
      where: { toEmail: TEST_EMAIL, type: 'password_reset_otp' },
    });
    expect(otpLogs.length).toBeGreaterThanOrEqual(1);
    expect(otpLogs[0].status).toBe('skipped');
  });

  it('reset-password writes a password_reset_completed row on success', async () => {
    // Skip the OTP round-trip (already covered above) — sign a reset-purpose
    // JWT directly with the same secret + 'password-reset' purpose marker the
    // verifyResetOtp step would have produced.
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../config/index.js');
    const resetToken = jwt.default.sign(
      { userId: testUserId, purpose: 'password-reset' },
      config.jwt.accessSecret,
      { expiresIn: '5m' },
    );

    const NEW_PASSWORD = 'Reset@9999';
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ resetToken, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    const logs = await prisma.emailLog.findMany({
      where: { toEmail: TEST_EMAIL, type: 'password_reset_completed' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('skipped');
    expect(logs[0].errorText).toBe('SMTP not configured');
    expect(logs[0].userId).toBe(testUserId);
    expect(logs[0].subject).toBe('Your MyGasLink password has been reset');
  });

  it('reset-password with an invalid token does NOT send the email', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ resetToken: 'not-a-real-token', newPassword: 'Reset@9999', confirmPassword: 'Reset@9999' });
    expect(res.status).not.toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const count = await prisma.emailLog.count({
      where: { toEmail: TEST_EMAIL, type: 'password_reset_completed' },
    });
    expect(count).toBe(0);
  });
});
