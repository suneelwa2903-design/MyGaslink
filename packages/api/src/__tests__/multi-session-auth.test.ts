/**
 * multi-session-auth.test.ts
 *
 * Item 4 (docs/INVESTIGATION-JUL09-B.md) — refresh tokens moved from a
 * single-slot User.refreshToken column to a N-slot RefreshTokenSession
 * table. Pins:
 *   - login creates a RefreshTokenSession row
 *   - Device A refresh does NOT invalidate Device B's refresh
 *   - logout revokes only the presenting session (other devices still work)
 *   - changePassword revokes ALL sessions
 *   - Expired session → 401
 *   - Revoked session → 401
 *
 * Uses a dedicated test user (email must be unique on `users`) so parallel
 * test files don't step on each other.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { login, refreshTokens, logout, changePassword, AuthError, hashPassword } from '../services/authService.js';

const TEST_EMAIL = `item4-multi-session-${Date.now().toString(36)}@test.local`;
const TEST_PASSWORD = 'ItemTest#12345';
let testUserId: string;

beforeAll(async () => {
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const user = await prisma.user.create({
    data: {
      email: TEST_EMAIL,
      passwordHash,
      firstName: 'Multi',
      lastName: 'Session',
      role: 'distributor_admin',
      status: 'active',
      distributorId: 'dist-001',
      requiresPasswordReset: false,
    },
  });
  testUserId = user.id;
});

afterAll(async () => {
  await prisma.refreshTokenSession.deleteMany({ where: { userId: testUserId } });
  await prisma.user.delete({ where: { id: testUserId } });
});

describe('Item 4 — multi-session refresh tokens', () => {
  it('T1 — login creates a RefreshTokenSession row', async () => {
    const before = await prisma.refreshTokenSession.count({ where: { userId: testUserId } });
    await login(TEST_EMAIL, TEST_PASSWORD, undefined, 'test-device-A');
    const after = await prisma.refreshTokenSession.count({ where: { userId: testUserId } });
    expect(after).toBe(before + 1);
  });

  it('T2 — refresh on a valid session issues new pair + updates session hash (rotation)', async () => {
    const { tokens: first } = await login(TEST_EMAIL, TEST_PASSWORD, undefined, 'test-device-T2');
    const rotated = await refreshTokens(first.refreshToken);
    // Access tokens use second-precision `iat`; two calls in the same
    // second can produce the same access token. Refresh tokens include
    // `jti: randomUUID()` so they're guaranteed distinct — that's the
    // rotation invariant we actually care about.
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    // Rotated old token → 401.
    await expect(refreshTokens(first.refreshToken)).rejects.toBeInstanceOf(AuthError);
  });

  it('T3 — Device A refresh does NOT invalidate Device B refresh (the item-4 fix)', async () => {
    const { tokens: a } = await login(TEST_EMAIL, TEST_PASSWORD, undefined, 'test-device-B-A');
    const { tokens: b } = await login(TEST_EMAIL, TEST_PASSWORD, undefined, 'test-device-B-B');
    // Device A refreshes — this was the case that broke Device B pre-fix.
    const aRotated = await refreshTokens(a.refreshToken);
    expect(aRotated.refreshToken).not.toBe(a.refreshToken);
    // Device B should still refresh successfully.
    const bRotated = await refreshTokens(b.refreshToken);
    expect(bRotated.refreshToken).not.toBe(b.refreshToken);
  });

  it('T4 — logout revokes only the presenting session; sibling sessions stay valid', async () => {
    const { tokens: a } = await login(TEST_EMAIL, TEST_PASSWORD, undefined, 'test-device-T4-A');
    const { tokens: b } = await login(TEST_EMAIL, TEST_PASSWORD, undefined, 'test-device-T4-B');
    await logout(testUserId, a.refreshToken);
    // A refresh fails.
    await expect(refreshTokens(a.refreshToken)).rejects.toBeInstanceOf(AuthError);
    // B refresh still works.
    const bRotated = await refreshTokens(b.refreshToken);
    expect(bRotated.refreshToken).not.toBe(b.refreshToken);
  });

  it('T5 — changePassword revokes ALL sessions', async () => {
    const { tokens: a } = await login(TEST_EMAIL, TEST_PASSWORD, undefined, 'test-device-T5-A');
    const { tokens: b } = await login(TEST_EMAIL, TEST_PASSWORD, undefined, 'test-device-T5-B');
    const newPassword = 'ItemTest#ABCDEF';
    await changePassword(testUserId, TEST_PASSWORD, newPassword);
    // Both refresh attempts fail.
    await expect(refreshTokens(a.refreshToken)).rejects.toBeInstanceOf(AuthError);
    await expect(refreshTokens(b.refreshToken)).rejects.toBeInstanceOf(AuthError);
    // Reset the user's password to the original for downstream tests.
    await changePassword(testUserId, newPassword, TEST_PASSWORD);
  });

  it('T6 — expired session refresh → 401', async () => {
    const { tokens } = await login(TEST_EMAIL, TEST_PASSWORD, undefined, 'test-device-T6');
    // Manually expire the session in the DB.
    const session = await prisma.refreshTokenSession.findFirst({
      where: { userId: testUserId, deviceLabel: 'test-device-T6' },
      orderBy: { createdAt: 'desc' },
    });
    expect(session).not.toBeNull();
    await prisma.refreshTokenSession.update({
      where: { id: session!.id },
      data: { expiresAt: new Date(Date.now() - 10_000) },
    });
    await expect(refreshTokens(tokens.refreshToken)).rejects.toBeInstanceOf(AuthError);
  });

  it('T7 — revoked session refresh → 401', async () => {
    const { tokens } = await login(TEST_EMAIL, TEST_PASSWORD, undefined, 'test-device-T7');
    const session = await prisma.refreshTokenSession.findFirst({
      where: { userId: testUserId, deviceLabel: 'test-device-T7' },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.refreshTokenSession.update({
      where: { id: session!.id },
      data: { revokedAt: new Date() },
    });
    await expect(refreshTokens(tokens.refreshToken)).rejects.toBeInstanceOf(AuthError);
  });

  it('T8 — deviceLabel persists on the row', async () => {
    const label = 'unique-device-label-T8';
    await login(TEST_EMAIL, TEST_PASSWORD, undefined, label);
    const session = await prisma.refreshTokenSession.findFirst({
      where: { userId: testUserId, deviceLabel: label },
    });
    expect(session).not.toBeNull();
    expect(session!.deviceLabel).toBe(label);
  });
});
