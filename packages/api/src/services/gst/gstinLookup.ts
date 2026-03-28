/**
 * GSTIN Lookup Service
 * Uses WhiteBooks e-Invoice API to fetch taxpayer details by GSTIN.
 * Also provides geocoding via Nominatim (OpenStreetMap) for address-to-coordinates.
 */

import { prisma } from '../../lib/prisma.js';
import { getCredentials, getAuthToken, GstError } from './whitebooksClient.js';
import { logger } from '../../utils/logger.js';
import { INDIAN_STATES } from '@gaslink/shared';

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

function buildAddressString(addr: Record<string, string | undefined>): string {
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
 * Look up GSTIN details via WhiteBooks e-Invoice API
 * Uses GasLink-level credentials first, falls back to any available distributor credentials
 */
export async function lookupGstin(gstin: string): Promise<GstinDetails> {
  // Try GasLink-level credentials first, then fall back to any available
  let creds = await getCredentials(null, 'einvoice');
  let credDistributorId: string | null = null;

  if (!creds) {
    // Fall back: find any distributor with valid einvoice credentials
    const fallbackCred = await prisma.gstCredential.findFirst({
      where: { scope: 'einvoice' },
      include: { distributor: { select: { id: true, gstMode: true } } },
    });
    if (!fallbackCred) {
      throw new GstError('No GST credentials configured. Please set up WhiteBooks credentials in Settings.', 'NO_CREDENTIALS');
    }
    credDistributorId = fallbackCred.distributorId;
    const isSandbox = fallbackCred.distributor?.gstMode === 'sandbox' || !fallbackCred.distributor;
    creds = {
      clientId: fallbackCred.clientId,
      clientSecret: fallbackCred.clientSecret,
      username: fallbackCred.username,
      password: fallbackCred.password,
      gstin: fallbackCred.gstin,
      email: fallbackCred.email || 'info@mygaslink.com',
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

  const emailParam = encodeURIComponent(creds.email || 'info@mygaslink.com');
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
        const errors = JSON.parse(json.status_desc);
        if (Array.isArray(errors) && errors.length > 0) {
          errorMsg = errors.map((e: any) => `[${e.ErrorCode}] ${e.ErrorMessage}`).join('; ');
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
  const finalAddress = address || (nestedAddr ? buildAddressString(nestedAddr as any) : '');

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
