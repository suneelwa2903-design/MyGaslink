/**
 * Distance calculation for e-Way Bill compliance.
 *
 * BEST PRACTICE: Use transDistance: 0 to let the e-Way Bill system
 * auto-populate distance from its internal PIN-to-PIN database.
 * Only provide manual distance when PINs are not in the system database.
 *
 * Rules:
 * - System validates ±10% tolerance against its PIN database
 * - For distances < 100km: only +10% allowed (no negative tolerance)
 * - Same pincode: max 100km (300km for line sales)
 * - Max distance: 4000km
 * - transDistance: 0 = auto-populate (safest)
 */

/**
 * Calculate distance between two points.
 * Priority: lat/lon coordinates > pincode estimation > default
 */
export function calculateDistance(
  from: { lat?: number | null; lon?: number | null; pincode?: string },
  to: { lat?: number | null; lon?: number | null; pincode?: string }
): number {
  // Use coordinates if both available
  if (from.lat && from.lon && to.lat && to.lon) {
    return haversineDistance(from.lat, from.lon, to.lat, to.lon);
  }
  // Fall back to pincode estimation
  if (from.pincode && to.pincode) {
    return estimateDistanceFromPincodes(from.pincode, to.pincode);
  }
  return 100; // Default
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const distance = R * c;
  // Road distance is ~1.3x straight-line distance. Round up to nearest 10.
  const roadDistance = distance * 1.3;
  return Math.min(4000, Math.max(1, Math.ceil(roadDistance / 10) * 10));
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Estimate distance from Indian pincodes.
 * Uses pincode prefix hierarchy: region (1st digit) > sub-region (2 digits) > district (3 digits)
 */
export function estimateDistanceFromPincodes(fromPin: string, toPin: string): number {
  if (!fromPin || !toPin || fromPin.length < 3 || toPin.length < 3) return 100;

  const fromRegion = fromPin[0];
  const toRegion = toPin[0];
  const fromSubRegion = fromPin.substring(0, 2);
  const toSubRegion = toPin.substring(0, 2);
  const fromDistrict = fromPin.substring(0, 3);
  const toDistrict = toPin.substring(0, 3);

  if (fromPin === toPin) return 10;
  if (fromDistrict === toDistrict) return 50;
  if (fromSubRegion === toSubRegion) return 100;

  // Use 2-digit sub-region pairs for more accurate inter-city/state distances
  // These cover major Indian postal zones with road distances + 15% buffer
  const subRegionDistance: Record<string, number> = {
    // Karnataka (56) to other states
    '5650': 600, '5036': 600, // KA↔TG (Bangalore-Hyderabad ~570km)
    '5640': 700, '4056': 700, // KA↔MH (Bangalore-Mumbai ~980km but MH is 40-41)
    '5641': 1000,'4156': 1000,// KA↔MH Mumbai
    '5660': 350, '6056': 350, // KA↔TN (Bangalore-Chennai ~350km)
    '5652': 600, '5256': 600, // KA↔AP
    '5651': 550, '5156': 550, // KA↔AP (Vizag)
    '5667': 400, '6756': 400, // KA↔KL
    '5630': 450, '3056': 450, // KA↔Goa
    // Telangana (50) distances
    '5053': 600, '5350': 600, // TG↔TN
    '5040': 550, '4050': 550, // TG↔MH (Hyd-Pune)
    '5041': 750, '4150': 750, // TG↔MH (Hyd-Mumbai)
    // Add more as needed
  };
  const key1 = fromSubRegion + toSubRegion;
  const key2 = toSubRegion + fromSubRegion;
  const knownDist = subRegionDistance[key1] || subRegionDistance[key2];
  if (knownDist) return Math.ceil(knownDist / 50) * 50;

  // Fallback: same region but different sub-region
  if (fromRegion === toRegion) return 400;
  // Different regions
  return 800;
}
