/**
 * WI-067 — Pincode → distance lookup for NIC EWB transDistance.
 *
 * Live failure on 2026-05-19: ORD-MPC8P2SQ9LV from Bangalore (560001)
 * to Hyderabad (500016) was rejected by NIC with error 702
 * ("The distance between the pincodes given is too high or low")
 * because `transDistance: '1'` (the WI-057 clamp-minimum) wildly
 * underrepresents the ~575km road distance.
 *
 * Design:
 *  - Bundle a hand-curated CSV at packages/api/src/data/pincodes.csv
 *    with PIN → (lat, lon) for 9 major Indian metros.
 *  - Compute Haversine straight-line distance at request time. NIC
 *    accepts ±10% tolerance vs road distance, which Haversine
 *    typically falls within for Indian metro pairs.
 *  - For pincodes not in the table, return `'0'` to let NIC's own
 *    pincode lookup compute the distance server-side. (NIC's
 *    sandbox rejected `'0'` historically per WI-057 — but only
 *    when other payload fields were also malformed; the '0'
 *    sentinel is the documented auto-calc value and is the right
 *    fallback once the rest of the payload is correct.)
 *  - Same-pincode pairs short-circuit to `'1'` (NIC minimum).
 *
 * Lookup table is loaded ONCE at module init, cached in a Map for
 * O(1) lookups thereafter. Memory cost: ~775 entries × ~40 bytes
 * ≈ 30 KB. Negligible.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

interface PinCoord {
  lat: number;
  lon: number;
}

const pinMap = new Map<string, PinCoord>();
let loaded = false;

/**
 * Resolve the bundled CSV path. With ESM + tsx-watch in dev the file
 * lives next to the .ts source; in a `tsc` build it lives next to the
 * .js output. `import.meta.url` resolves both cases without extra
 * config. We also probe a couple of fallback locations so manual
 * dev-only overrides (e.g. a richer all-India CSV at /tmp/pincodes.csv)
 * can be dropped in without code changes.
 */
function candidatePaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, '..', 'data', 'pincodes.csv'),                  // src/data/ or dist/data/ — co-located by package layout
    join(process.cwd(), 'packages', 'api', 'src', 'data', 'pincodes.csv'),
    join(process.cwd(), 'src', 'data', 'pincodes.csv'),
    '/tmp/pincodes.csv',                                        // hand-dropped richer CSV (dev only)
  ];
}

function loadPincodes(): void {
  if (loaded) return;
  loaded = true; // mark even on failure so we don't retry on every call

  for (const p of candidatePaths()) {
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/);
    if (lines.length === 0) continue;

    // Detect header: try to find column indices for pin / lat / lon.
    const firstLine = lines[0].toLowerCase();
    let pinIdx = 0;
    let latIdx = 1;
    let lonIdx = 2;
    let startIdx = 0;
    if (firstLine.includes('pin') || firstLine.includes('lat')) {
      const headers = firstLine.split(',').map((h) => h.trim());
      const findIdx = (...needles: string[]) =>
        headers.findIndex((h) => needles.some((n) => h === n || h.includes(n)));
      const detectedPin = findIdx('pincode', 'pin');
      const detectedLat = findIdx('latitude', 'lat');
      const detectedLon = findIdx('longitude', 'lon', 'lng');
      if (detectedPin >= 0) pinIdx = detectedPin;
      if (detectedLat >= 0) latIdx = detectedLat;
      if (detectedLon >= 0) lonIdx = detectedLon;
      startIdx = 1; // skip header
    }

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cols = line.split(',');
      if (cols.length <= Math.max(pinIdx, latIdx, lonIdx)) continue;
      const pin = cols[pinIdx]?.trim();
      const lat = parseFloat(cols[latIdx]);
      const lon = parseFloat(cols[lonIdx]);
      if (pin && /^\d{6}$/.test(pin) && Number.isFinite(lat) && Number.isFinite(lon)) {
        pinMap.set(pin, { lat, lon });
      }
    }

    if (pinMap.size > 0) {
      logger.info('[pincodeDistance] Pincode table loaded', { count: pinMap.size, source: p });
      return;
    }
  }

  logger.warn('[pincodeDistance] No pincode CSV loaded — getTransDistance will fall back to "0" (NIC auto-calc) for every call');
}

/**
 * Haversine great-circle distance between two lat/lon points, in km.
 */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth mean radius in km
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Test-only hook: clear the cached lookup so tests can mutate the
 * underlying CSV file between cases. Not exported via the package's
 * main `index.ts` — only imported by gst-dispatch-trip.test.ts.
 *
 * @internal
 */
export function __resetPincodeCache(): void {
  pinMap.clear();
  loaded = false;
}

/**
 * Straight-line Haversine distance in km between two Indian pincodes.
 * Returns null when either pincode is missing from the lookup table —
 * the caller is expected to fall back to NIC's auto-calc by sending
 * `'0'` for transDistance.
 *
 * NOTE: this is straight-line (great-circle) only. Callers building a
 * NIC EWB transDistance value must apply a road-circuity factor —
 * see `getTransDistance` below for the right wrapper.
 */
export function getDistanceKm(fromPin: string | null | undefined, toPin: string | null | undefined): number | null {
  if (!fromPin || !toPin) return null;
  loadPincodes();
  const from = pinMap.get(fromPin.trim());
  const to = pinMap.get(toPin.trim());
  if (!from || !to) return null;
  const km = haversineKm(from.lat, from.lon, to.lat, to.lon);
  // Ceil to integer km, floor at 1 (NIC rejects 0 for a non-empty payload).
  return Math.max(1, Math.ceil(km));
}

/**
 * Road circuity factor — multiplier from Haversine straight-line to
 * estimated road distance. WI-067 sent the raw Haversine value, but
 * NIC validates transDistance within ±10% of its internal ROAD
 * distance calculation, and road distance in India is empirically
 * ~15% longer than great-circle for inter-metro pairs. Concrete:
 *
 *   Bangalore (560001) → Hyderabad (500016)
 *     Haversine straight-line  ≈ 500 km
 *     Real road distance       ≈ 575 km
 *     NIC ±10% window          ≈ 517 – 632 km
 *     Sending raw 500          → 702 (below window) — observed live 2026-05-19
 *     500 × 1.15 = 575         → inside window ✓
 *
 * 4000 km is NIC's hard upper bound for transDistance.
 */
const ROAD_CIRCUITY_FACTOR = 1.15;
const NIC_MAX_TRANS_DISTANCE_KM = 4000;

/**
 * Convert a Haversine straight-line distance to a NIC-ready road
 * distance estimate, clamped to [1, 4000].
 *
 * Exported separately so the cap and circuity math are unit-testable
 * without having to mock the CSV table (the real bundled CSV maxes
 * out at ~1750 km / 2010 km post-circuity — nowhere near the cap).
 */
export function _roadDistanceFromHaversine(haversineKm: number): number {
  const roadEstimate = Math.ceil(haversineKm * ROAD_CIRCUITY_FACTOR);
  return Math.max(1, Math.min(roadEstimate, NIC_MAX_TRANS_DISTANCE_KM));
}

/**
 * NIC-ready transDistance value.
 *   missing pin / unknown pin → "0"  (NIC auto-calc)
 *   same pincode              → "1"  (NIC minimum non-zero)
 *   known pin pair            → ceil(haversine_km × 1.15) clamped to [1, 4000]
 */
export function getTransDistance(
  fromPin: string | null | undefined,
  toPin: string | null | undefined,
): string {
  if (!fromPin || !toPin) return '0';
  if (fromPin.trim() === toPin.trim()) return '1';
  const straightLine = getDistanceKm(fromPin, toPin);
  if (straightLine === null) {
    logger.warn('[pincodeDistance] Unknown pincode pair, falling back to NIC auto-calc', { fromPin, toPin });
    return '0';
  }
  return String(_roadDistanceFromHaversine(straightLine));
}
