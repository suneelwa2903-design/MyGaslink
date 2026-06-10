/**
 * GSTIN Lookup Service
 * Uses WhiteBooks e-Invoice API to fetch taxpayer details by GSTIN.
 * Also provides geocoding via Nominatim (OpenStreetMap) for address-to-coordinates.
 */

import { prisma } from '../../lib/prisma.js';
import { getCredentials, getAuthToken, getLayer1Credentials, GstError } from './whitebooksClient.js';
import { logger } from '../../utils/logger.js';
import { INDIAN_STATES } from '@gaslink/shared';
import type { NicError } from './nicTypes.js';

const DEFAULT_IP = '127.0.0.1';

interface GstinApiResponse {
  status_cd: string | number;
  data?: {
    Gstin?: string;
    // WhiteBooks sandbox format
    TradeName?: string;   // Trade name
    LegalName?: string;   // Legal name
    StateCode?: number;   // State code as number
    TxpType?: string;     // Taxpayer type (REG, etc.)
    Status?: string;      // Status (ACT/INA/CAN)
    BlkStatus?: string;   // Block status (U/B)
    // NIC production format
    TrdNm?: string;   // Trade name (business name)
    LglNm?: string;   // Legal name
    AddrBnm?: string;  // Building name
    AddrBno?: string;  // Building/flat number
    AddrFlno?: string; // Floor number
    AddrSt?: string;   // Street
    AddrLoc?: string;  // Locality
    AddrDst?: string;  // District
    AddrPncd?: string | number; // Pincode
    AddrStcd?: string; // State code (2 digit)
    BlkSts?: string;   // Block status (Active/Inactive)
    DtReg?: string;    // Date of registration
    DtDReg?: string;   // Date of deregistration
    CtbTyp?: string;   // Taxpayer type (Regular/Composition etc.)
    CtjCd?: string;    // Jurisdiction code
    EinvoiceStatus?: string;
    // NIC format nested address
    pradr?: {
      addr?: {
        bnm?: string;
        bno?: string;
        flno?: string;
        st?: string;
        loc?: string;
        dst?: string;
        pncd?: string;
        stcd?: string;
        city?: string;
      };
      ntr?: string; // Nature of business
    };
    // Additional addresses (godowns, branches)
    adadr?: Array<{
      addr?: {
        bnm?: string;
        bno?: string;
        flno?: string;
        st?: string;
        loc?: string;
        dst?: string;
        pncd?: string;
        stcd?: string;
        city?: string;
      };
      ntr?: string;
    }>;
    ctb?: string;    // Constitution of business
    rgdt?: string;   // Registration date
    lstupdt?: string; // Last updated
    sts?: string;    // Status (Active/Cancelled etc.)
    tradeNam?: string;
    lgnm?: string;   // Legal name (alternate field)
  };
  status_desc?: string;
}

export interface GstinDetails {
  gstin: string;
  legalName: string;
  tradeName: string;
  address: string;
  city: string;
  state: string;
  stateCode: string;
  pincode: string;
  status: string;
  registrationType: string;
  businessType: string;
  registrationDate: string | null;
  additionalAddresses: Array<{
    address: string;
    city: string;
    state: string;
    stateCode: string;
    pincode: string;
  }>;
}

/** Nested NIC address block (`pradr.addr` / `adadr[].addr`) plus the flat
 * sandbox `Addr*` aliases that some responses inline. All fields optional. */
type NicAddressBlock = {
  bnm?: string; bno?: string; flno?: string; st?: string; loc?: string;
  dst?: string; pncd?: string; stcd?: string; city?: string;
  AddrBno?: string; AddrFlno?: string; AddrBnm?: string; AddrSt?: string;
  AddrLoc?: string;
};

function buildAddressString(addr: NicAddressBlock): string {
  const parts = [
    addr.bno || addr.AddrBno,
    addr.flno || addr.AddrFlno,
    addr.bnm || addr.AddrBnm,
    addr.st || addr.AddrSt,
    addr.loc || addr.AddrLoc,
  ].filter(Boolean);
  return parts.join(', ');
}

function getStateName(stateCode: string): string {
  const padded = stateCode.padStart(2, '0');
  return (INDIAN_STATES as Record<string, string>)[padded] || stateCode;
}

/**
 * Look up GSTIN details via WhiteBooks e-Invoice API.
 *
 * WI-058 — tenant-scoped lookup. Callers MUST pass the
 * authenticated user's `distributorId` so we use that tenant's own
 * WhiteBooks credentials. The legacy unscoped fallback (used when a
 * caller has no creds of their own) is retained but hardened:
 *   - `isValid: true` required (skip never-validated rows)
 *   - `email` not null required (the auth URL needs it)
 *   - deterministic `orderBy: lastValidated desc` so a test-leaked
 *     row can't win a race with a real row
 *
 * The 2026-05-16 outage we misdiagnosed for ~24h was caused by this
 * function picking a leaked dist-001 test row (no tenant filter, no
 * isValid check, no deterministic order) and routing every Sharma
 * admin's GSTIN lookup through production WhiteBooks with bogus
 * credentials. See [docs/anti-pattern #13](../../../CLAUDE.md).
 */
export async function lookupGstin(
  gstin: string,
  distributorId: string,
): Promise<GstinDetails> {
  // Prefer the caller's own tenant credentials — but only if they're
  // (a) marked valid and (b) carry a real email. The 2026-05-16
  // outage was caused by a NULL-email row silently falling back to
  // 'info@mygaslink.com' which production WhiteBooks rejected.
  const ownRow = await prisma.gstCredential.findFirst({
    where: {
      distributorId,
      scope: 'einvoice',
      isValid: true,
      email: { not: null },
    },
    include: { distributor: { select: { gstMode: true } } },
  });
  let creds = ownRow
    ? (() => {
        const isSandbox = ownRow.distributor?.gstMode === 'sandbox' || !ownRow.distributor;
        const authMode: 'sandbox' | 'live' = isSandbox ? 'sandbox' : 'live';
        // Group A: env-first Layer 1, DB fallback only in sandbox.
        const layer1 = getLayer1Credentials('einvoice', authMode);
        return {
          clientId: layer1?.clientId ?? ownRow.clientId,
          clientSecret: layer1?.clientSecret ?? ownRow.clientSecret,
          username: ownRow.username,
          password: ownRow.password,
          gstin: ownRow.gstin,
          // Group A revision: email is GasLink-global (Layer 1 env). Sandbox
          // may fall back to legacy DB email; live throws upstream via Layer 1.
          email: layer1?.email ?? ownRow.email ?? (() => {
            throw new GstError(
              'GasLink WhiteBooks email-of-record not configured (env + DB both empty)',
              'NO_GASLINK_EMAIL',
            );
          })(),
          baseUrl: isSandbox
            ? 'https://apisandbox.whitebooks.in'
            : 'https://api.whitebooks.in',
        };
      })()
    : null;
  let credDistributorId: string | null = ownRow ? distributorId : null;
  // Silence unused-import warning when this path is skipped.
  void getCredentials;

  if (!creds) {
    // Fallback path — only when the caller's tenant has no einvoice
    // credentials at all. Tighter `where` clauses here than the
    // historical bug so a leaked/invalid row can never hijack.
    const fallbackCred = await prisma.gstCredential.findFirst({
      where: {
        scope: 'einvoice',
        isValid: true,
        email: { not: null },
      },
      orderBy: { lastValidated: 'desc' },
      include: { distributor: { select: { id: true, gstMode: true } } },
    });
    if (!fallbackCred) {
      throw new GstError(
        'No GST credentials configured for this distributor. Please set them up in Settings.',
        'NO_CREDENTIALS',
      );
    }
    credDistributorId = fallbackCred.distributorId;
    const isSandbox = fallbackCred.distributor?.gstMode === 'sandbox' || !fallbackCred.distributor;
    const authMode: 'sandbox' | 'live' = isSandbox ? 'sandbox' : 'live';
    // Group A: env-first Layer 1, DB fallback only in sandbox.
    const layer1 = getLayer1Credentials('einvoice', authMode);
    creds = {
      clientId: layer1?.clientId ?? fallbackCred.clientId,
      clientSecret: layer1?.clientSecret ?? fallbackCred.clientSecret,
      username: fallbackCred.username,
      password: fallbackCred.password,
      gstin: fallbackCred.gstin,
      // Group A revision: email is GasLink-global (Layer 1 env). Fallback to
      // legacy DB email for sandbox backward compat; throw if neither.
      email: layer1?.email ?? fallbackCred.email ?? (() => {
        throw new GstError(
          'GasLink WhiteBooks email-of-record not configured (env + DB both empty)',
          'NO_GASLINK_EMAIL',
        );
      })(),
      baseUrl: isSandbox ? 'https://apisandbox.whitebooks.in' : 'https://api.whitebooks.in',
    };
  }

  const token = await getAuthToken(credDistributorId, 'einvoice');

  const headers: Record<string, string> = {
    'ip_address': DEFAULT_IP,
    'client_id': creds.clientId,
    'gstin': creds.gstin,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'username': creds.username,
  };
  if (creds.clientSecret) headers['client_secret'] = creds.clientSecret;
  if (token !== 'no-token-needed') headers['auth-token'] = token;

  // Group A revision: creds.email is now GasLink-global (Layer 1 env).
  // getCredentials throws NO_GASLINK_EMAIL if neither env nor legacy DB
  // has a value, so creds.email is guaranteed populated here.
  const emailParam = encodeURIComponent(creds.email);
  const url = `${creds.baseUrl}/einvoice/type/GSTNDETAILS/version/V1_03?param1=${gstin}&email=${emailParam}`;
  logger.info('GSTIN lookup request', { gstin, url });

  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  let json: GstinApiResponse;
  try {
    json = JSON.parse(text) as GstinApiResponse;
  } catch {
    logger.error('GSTIN lookup: non-JSON response', { gstin, text: text.substring(0, 500) });
    throw new GstError('Invalid response from GST API', 'GSTIN_LOOKUP_FAILED');
  }

  const isSuccess = json.status_cd === '1' || json.status_cd === 1 ||
    json.status_cd === 'Sucess' || json.status_cd === 'Success';

  if (!isSuccess) {
    logger.error('GSTIN lookup failed', { gstin, status_cd: json.status_cd, status_desc: json.status_desc, fullResponse: JSON.stringify(json) });
    // Parse detailed error from status_desc if it's JSON
    let errorMsg = json.status_desc || `GSTIN lookup failed for ${gstin}`;
    if (typeof json.status_desc === 'string') {
      try {
        const errors = JSON.parse(json.status_desc) as NicError[];
        if (Array.isArray(errors) && errors.length > 0) {
          errorMsg = errors.map((e) => `[${e.ErrorCode}] ${e.ErrorMessage}`).join('; ');
        }
      } catch {
        // Not JSON, use as-is
      }
    }
    throw new GstError(errorMsg, 'GSTIN_LOOKUP_FAILED');
  }

  const data = json.data;
  if (!data) {
    throw new GstError('No data returned for GSTIN lookup', 'GSTIN_LOOKUP_FAILED');
  }

  // WhiteBooks returns StateCode as number, AddrPncd as number
  const stateCode = String(data.StateCode || data.AddrStcd || gstin.substring(0, 2)).padStart(2, '0');

  // Build address from flat fields (WhiteBooks sandbox format)
  const addressParts = [
    data.AddrBno,
    data.AddrFlno,
    data.AddrBnm,
    data.AddrSt,
    data.AddrLoc,
  ].filter((p) => p && String(p).trim());
  const address = addressParts.join(', ').trim();

  // Also check for nested address format (NIC production format)
  const nestedAddr = data.pradr?.addr;
  const finalAddress = address || (nestedAddr ? buildAddressString(nestedAddr) : '');

  // City: use locality, district, or building name as fallback
  const city = (data.AddrLoc || nestedAddr?.loc || nestedAddr?.dst || data.AddrDst || data.AddrBnm || '').trim();

  const pincode = String(data.AddrPncd || nestedAddr?.pncd || '');

  // Parse additional addresses (godowns, branches) — NIC format
  const additionalAddresses = (data.adadr || []).map((ad) => {
    const addr = ad.addr || {};
    return {
      address: buildAddressString(addr),
      city: (addr.city || addr.dst || addr.loc || '').trim(),
      state: getStateName(addr.stcd || stateCode),
      stateCode: addr.stcd || stateCode,
      pincode: addr.pncd || '',
    };
  });

  // Status mapping: ACT = Active, INA = Inactive, CAN = Cancelled
  const statusMap: Record<string, string> = {
    'ACT': 'Active', 'INA': 'Inactive', 'CAN': 'Cancelled', 'SUS': 'Suspended',
    'U': 'Unblocked', 'B': 'Blocked',
  };
  const rawStatus = data.Status || data.sts || data.BlkSts || '';
  const status = statusMap[rawStatus] || rawStatus || 'Unknown';

  // Clean legal name (sandbox returns trailing spaces)
  const legalName = (data.LegalName || data.LglNm || data.lgnm || '').trim();
  const tradeName = (data.TradeName || data.TrdNm || data.tradeNam || '').trim();

  // Fail loud when NIC returns success status but a payload missing the
  // fields the customer-create flow depends on. Silently defaulting to
  // empty strings (the previous behavior) hides upstream regressions and
  // is the receiving-side dual of CLAUDE.md anti-pattern #6. State code
  // also has to be a real 2-digit GST state code so downstream IRN
  // payloads don't get rejected at NIC validation.
  const requiredMissing: string[] = [];
  if (!legalName) requiredMissing.push('legalName');
  if (!stateCode || !/^\d{2}$/.test(stateCode)) requiredMissing.push('stateCode');
  if (!status) requiredMissing.push('status');
  if (requiredMissing.length > 0) {
    throw new Error(
      `GSTIN lookup response for ${gstin} is missing required fields: ${requiredMissing.join(', ')}`,
    );
  }

  return {
    gstin: data.Gstin || gstin,
    legalName,
    tradeName: tradeName || legalName,
    address: finalAddress,
    city,
    state: getStateName(stateCode),
    stateCode,
    pincode,
    status,
    registrationType: data.TxpType || data.CtbTyp || data.ctb || '',
    businessType: data.pradr?.ntr || '',
    registrationDate: data.DtReg || data.rgdt || null,
    additionalAddresses,
  };
}

/**
 * Geocode an address to latitude/longitude using Nominatim (OpenStreetMap).
 * Free, no API key needed. Rate limited to 1 req/sec.
 */
export async function geocodeAddress(address: string, city: string, state: string, pincode: string): Promise<{ latitude: number; longitude: number } | null> {
  try {
    // Build a structured query for better results
    const query = [address, city, state, pincode, 'India'].filter(Boolean).join(', ');
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      limit: '1',
      countrycodes: 'in',
    });

    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: {
        'User-Agent': 'GasLink-LPG-Distribution/1.0',
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      logger.warn('Geocoding request failed', { status: res.status });
      return null;
    }

    const results = await res.json() as Array<{ lat: string; lon: string }>;
    if (!results.length) {
      // Fallback: try with just pincode + state
      if (pincode) {
        const fallbackParams = new URLSearchParams({
          q: `${pincode}, ${state || ''}, India`,
          format: 'json',
          limit: '1',
          countrycodes: 'in',
        });
        const fallbackRes = await fetch(`https://nominatim.openstreetmap.org/search?${fallbackParams}`, {
          headers: {
            'User-Agent': 'GasLink-LPG-Distribution/1.0',
            'Accept': 'application/json',
          },
        });
        const fallbackResults = await fallbackRes.json() as Array<{ lat: string; lon: string }>;
        if (fallbackResults.length) {
          return {
            latitude: parseFloat(fallbackResults[0].lat),
            longitude: parseFloat(fallbackResults[0].lon),
          };
        }
      }
      logger.warn('Geocoding returned no results', { query });
      return null;
    }

    return {
      latitude: parseFloat(results[0].lat),
      longitude: parseFloat(results[0].lon),
    };
  } catch (err) {
    logger.warn('Geocoding error (non-critical)', { error: (err as Error).message });
    return null;
  }
}
