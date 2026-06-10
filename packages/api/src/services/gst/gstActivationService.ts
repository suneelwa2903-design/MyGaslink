/**
 * Group A Step 5 — Atomic GST activation / disable for super-admin.
 *
 * Three operations exposed:
 *   - previewTestConnection: stateless WhiteBooks probe using body-supplied
 *     Layer 2 creds + env-var Layer 1. No DB write. Powers the activation
 *     form's "Test Connection" button before save.
 *   - activate: validates transitions, runs Test Connection, then atomically
 *     upserts both gst_credentials rows + flips gst_mode + writes audit_log
 *     in a single Prisma transaction. Either everything succeeds or nothing.
 *   - disable: live → disabled with mandatory reason. Enforces the
 *     IN_FLIGHT_GST_DOCS guard (no open EWBs/IRNs). Preserves credential
 *     rows (does NOT delete) so re-activation reuses them if desired.
 *
 * All audit_log entries capture: actor, fromMode, toMode, reason, optional
 * reasonText, and a sha256[:16] credential fingerprint per scope so we can
 * detect rotation in retrospect without storing or echoing the value.
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  assertSandboxAllowed,
  assertNotLiveToSandbox,
  assertNoInFlightGstDocs,
  assertLiveHasCredentials,
  GstTransitionError,
} from './transitionGuards.js';

type GstMode = 'disabled' | 'sandbox' | 'live';

interface Layer2Creds {
  username: string;
  password: string;
}

interface ActivatePayload {
  mode: 'sandbox' | 'live';
  einvoice: Layer2Creds;
  ewaybill: Layer2Creds | 'same_as_einvoice';
  reason: 'new_distributor_activation' | 'credential_rotation' | 'mode_change' | 'revoke_access' | 'other';
  reasonText?: string;
}

interface DisablePayload {
  reason: 'mode_change' | 'revoke_access' | 'other' | 'new_distributor_activation' | 'credential_rotation';
  reasonText?: string;
}

export class GstActivationError extends Error {
  constructor(message: string, public code: string, public details?: unknown) {
    super(message);
    this.name = 'GstActivationError';
  }
}

/**
 * sha256[:16] of `username:password:gstin`. The point is detection of change
 * ("did the operator rotate creds?") without the value ever flowing back into
 * transcripts, audit dumps, or the API response. NEVER include the raw creds
 * in logs. (Email is GasLink-global Layer 1 now, not part of the per-tenant
 * Layer 2 fingerprint.)
 */
export function credentialFingerprint(creds: Layer2Creds, gstin: string): string {
  return createHash('sha256')
    .update(`${creds.username}:${creds.password}:${gstin}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Stateless WhiteBooks probe using the supplied Layer 2 creds + env Layer 1.
 * Calls the same auth path as a real request but with a synthetic credential
 * surface that lives only in memory. No DB read/write.
 *
 * Returns the same {authenticated, nicReachable, message, ...} shape as the
 * legacy /settings/gst/credentials/:scope/test endpoint for UI parity.
 */
export async function previewTestConnection(
  gstin: string,
  mode: 'sandbox' | 'live',
  scope: 'einvoice' | 'ewaybill',
  creds: Layer2Creds,
): Promise<{
  scope: string;
  authenticated: boolean;
  nicReachable: boolean;
  message: string;
  authError?: string;
  nicError?: string;
}> {
  const { getLayer1Credentials } = await import('./whitebooksClient.js');
  // Read Layer 1 from env. Throws NO_PROD_CREDS if mode='live' env vars empty.
  const layer1 = getLayer1Credentials(scope, mode);
  if (!layer1) {
    return {
      scope,
      authenticated: false,
      nicReachable: false,
      message: 'WhiteBooks sandbox credentials not configured in env',
      authError: 'Layer 1 sandbox env vars empty — cannot probe',
    };
  }

  const baseUrl = mode === 'sandbox'
    ? 'https://apisandbox.whitebooks.in'
    : 'https://api.whitebooks.in';
  // Group A revision: email comes from Layer 1 (GasLink-global), not from
  // per-distributor Layer 2 input.
  const emailParam = encodeURIComponent(layer1.email);

  // Hit /authenticate directly with the supplied creds. Mirror the auth
  // header / query-param split that whitebooksClient does for each scope.
  let endpoint: string;
  let headers: Record<string, string>;
  if (scope === 'einvoice') {
    endpoint = `/einvoice/authenticate?email=${emailParam}`;
    headers = {
      username: creds.username,
      password: creds.password,
      ip_address: process.env.EC2_PUBLIC_IP || '43.204.63.205',
      client_id: layer1.clientId,
      client_secret: layer1.clientSecret,
      gstin,
      Accept: 'application/json',
    };
  } else {
    const qs = new URLSearchParams({
      email: layer1.email,
      username: creds.username,
      password: creds.password,
    }).toString();
    endpoint = `/ewaybillapi/v1.03/authenticate?${qs}`;
    headers = {
      ip_address: process.env.EC2_PUBLIC_IP || '43.204.63.205',
      client_id: layer1.clientId,
      client_secret: layer1.clientSecret,
      gstin,
      Accept: 'application/json',
    };
  }

  let authenticated = false;
  let authError: string | undefined;
  try {
    const res = await fetch(`${baseUrl}${endpoint}`, { method: 'GET', headers });
    const json = await res.json() as { status_cd?: string | number; status_desc?: string };
    const ok = json.status_cd === '1' || json.status_cd === 1 ||
      json.status_cd === 'Sucess' || json.status_cd === 'Success';
    if (ok) {
      authenticated = true;
    } else {
      authError = json.status_desc || `WhiteBooks rejected with status_cd=${json.status_cd}`;
    }
  } catch (err: unknown) {
    authError = (err instanceof Error ? err.message : '') || 'WhiteBooks call failed';
  }

  // EWB auth doubles as the NIC reachability probe (same upstream). For
  // einvoice, a successful auth means WhiteBooks accepted the creds; the
  // legacy endpoint then does a GSTNDETAILS lookup as a second hop. For the
  // preview flow we keep it to auth-only — the dedicated /settings test endpoint
  // exercises the full two-stage probe.
  const message = authenticated
    ? 'WhiteBooks auth OK'
    : (authError || 'WhiteBooks authentication failed');

  return {
    scope,
    authenticated,
    nicReachable: authenticated,
    message,
    authError,
  };
}

/**
 * Atomic activation. Wraps:
 *   1. Distributor lookup + transition guards
 *   2. Test Connection on both scopes (NO DB write yet)
 *   3. prisma.$transaction: upsert ein-cred + upsert ewb-cred + update mode + audit
 *
 * If Test Connection fails on either scope, the transaction never opens.
 * If the transaction throws (constraint violation, audit insert fail, etc.),
 * Prisma rolls back everything: mode unchanged, creds unchanged.
 */
export async function activateGst(
  distributorId: string,
  payload: ActivatePayload,
  actorUserId: string,
): Promise<{ gstMode: GstMode; einvoiceFingerprint: string; ewaybillFingerprint: string }> {
  const dist = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { id: true, gstin: true, gstMode: true, isTestTenant: true },
  });
  if (!dist) {
    throw new GstActivationError(`Distributor ${distributorId} not found`, 'DISTRIBUTOR_NOT_FOUND');
  }
  if (!dist.gstin) {
    throw new GstActivationError(
      'Distributor has no GSTIN configured — cannot activate GST',
      'NO_DISTRIBUTOR_GSTIN',
    );
  }
  const fromMode = dist.gstMode as GstMode;
  const toMode = payload.mode;

  // Transition guards — both apply at the route layer of /settings/gst/mode
  // too, but we re-run here so the activation endpoint is self-sufficient.
  assertSandboxAllowed(toMode, dist.isTestTenant);
  assertNotLiveToSandbox(fromMode, toMode);
  // Step 4 guard: live mode requires Layer 2 creds for both scopes. With this
  // endpoint we're SUPPLYING the creds, so the precondition is trivially met
  // (we'd write them in the same transaction). Skip if going to sandbox.
  if (toMode === 'live') {
    assertLiveHasCredentials(toMode, true, true);
  }

  const einvoiceCreds = payload.einvoice;
  const ewaybillCreds = payload.ewaybill === 'same_as_einvoice'
    ? payload.einvoice
    : payload.ewaybill;

  // Run Test Connection on both scopes BEFORE opening the transaction. If
  // either fails, no DB writes happen at all.
  const [einTest, ewbTest] = await Promise.all([
    previewTestConnection(dist.gstin, toMode, 'einvoice', einvoiceCreds),
    previewTestConnection(dist.gstin, toMode, 'ewaybill', ewaybillCreds),
  ]);
  if (!einTest.authenticated || !ewbTest.authenticated) {
    throw new GstActivationError(
      'WhiteBooks rejected the supplied credentials',
      'TEST_CONNECTION_FAILED',
      {
        einvoice: einTest.authenticated
          ? { ok: true }
          : { ok: false, error: einTest.authError ?? einTest.message },
        ewaybill: ewbTest.authenticated
          ? { ok: true }
          : { ok: false, error: ewbTest.authError ?? ewbTest.message },
      },
    );
  }

  const einFp = credentialFingerprint(einvoiceCreds, dist.gstin);
  const ewbFp = credentialFingerprint(ewaybillCreds, dist.gstin);

  await prisma.$transaction(async (tx) => {
    const credUpsert = (scope: 'einvoice' | 'ewaybill', creds: Layer2Creds) => ({
      where: { distributorId_scope: { distributorId: dist.id, scope } },
      create: {
        distributorId: dist.id,
        scope,
        // Sentinels — Layer 1 (client_id/secret/email) lives in env vars.
        // These columns are kept on gst_credentials for legacy backward
        // compat but the runtime auth path no longer reads them.
        clientId: 'ENV_VAR_ROUTED',
        clientSecret: 'ENV_VAR_ROUTED',
        username: creds.username,
        password: creds.password,
        gstin: dist.gstin!,
        isValid: true,
        lastValidated: new Date(),
      },
      update: {
        username: creds.username,
        password: creds.password,
        gstin: dist.gstin!,
        isValid: true,
        lastValidated: new Date(),
      },
    });

    await tx.gstCredential.upsert(credUpsert('einvoice', einvoiceCreds));
    await tx.gstCredential.upsert(credUpsert('ewaybill', ewaybillCreds));

    await tx.distributor.update({
      where: { id: dist.id },
      data: { gstMode: toMode },
    });

    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        distributorId: dist.id,
        action: 'gst_activate',
        entityType: 'gst_activation',
        entityId: dist.id,
        details: {
          fromMode,
          toMode,
          reason: payload.reason,
          reasonText: payload.reasonText ?? null,
          einvoiceCredFingerprint: einFp,
          ewaybillCredFingerprint: ewbFp,
          sameCreds: payload.ewaybill === 'same_as_einvoice',
        } as Prisma.InputJsonValue,
      },
    });
  });

  return {
    gstMode: toMode,
    einvoiceFingerprint: einFp,
    ewaybillFingerprint: ewbFp,
  };
}

/**
 * Disable a live (or sandbox) tenant. Enforces IN_FLIGHT_GST_DOCS — no open
 * EWBs or pending IRNs. Preserves the gst_credentials rows so a future
 * re-activate skips re-entering them (the operator can flip back via the
 * activation flow with the same creds).
 */
export async function disableGst(
  distributorId: string,
  payload: DisablePayload,
  actorUserId: string,
): Promise<{ gstMode: GstMode }> {
  const dist = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { id: true, gstMode: true, isTestTenant: true },
  });
  if (!dist) {
    throw new GstActivationError(`Distributor ${distributorId} not found`, 'DISTRIBUTOR_NOT_FOUND');
  }
  const fromMode = dist.gstMode as GstMode;
  const toMode: GstMode = 'disabled';

  if (fromMode === 'disabled') {
    // Already disabled — no-op but still emit an audit entry so the operator
    // sees the action in the trail.
    await prisma.auditLog.create({
      data: {
        userId: actorUserId,
        distributorId: dist.id,
        action: 'gst_disable',
        entityType: 'gst_activation',
        entityId: dist.id,
        details: {
          fromMode,
          toMode,
          reason: payload.reason,
          reasonText: payload.reasonText ?? null,
          noop: true,
        } as Prisma.InputJsonValue,
      },
    });
    return { gstMode: toMode };
  }

  // Step 4 guard: live → disabled blocked when GST docs are still in flight.
  if (fromMode === 'live') {
    const inFlight = await prisma.gstDocument.count({
      where: {
        distributorId: dist.id,
        OR: [
          { ewbStatus: 'active' },
          { irnStatus: 'pending' },
        ],
      },
    });
    assertNoInFlightGstDocs(fromMode, toMode, inFlight);
  }

  await prisma.$transaction(async (tx) => {
    await tx.distributor.update({
      where: { id: dist.id },
      data: { gstMode: toMode },
    });
    await tx.auditLog.create({
      data: {
        userId: actorUserId,
        distributorId: dist.id,
        action: 'gst_disable',
        entityType: 'gst_activation',
        entityId: dist.id,
        details: {
          fromMode,
          toMode,
          reason: payload.reason,
          reasonText: payload.reasonText ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  });

  return { gstMode: toMode };
}

// Re-export the transition error so route handlers can `instanceof` it without
// importing from two modules.
export { GstTransitionError };
