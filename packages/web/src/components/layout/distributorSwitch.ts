// Pure decision logic for the DistributorSelector switch effect.
// Extracted so the rule is unit-testable without rendering React.
//
// Why this exists: the previous implementation guarded the effect with
// `prev && current && prev !== current`, which silently skipped the FIRST
// pick for a super-admin who landed with no selection (prev=null). Those
// pages had already issued queries without an `X-Distributor-Id` header
// and were sitting on empty / 4xx results — but the guard never let the
// cache refresh, so the user saw "no data" until they reloaded.
//
// Rules:
//  - non-super-admin: never invalidate. Their distributorId is fixed at
//    login; the auto-select in DistributorSelector fires before any
//    tenant-scoped query mounts (queries key on distributorId), so there
//    is nothing stale to clear.
//  - super-admin: invalidate whenever the selection changes, including
//    null → X (the case the old guard missed) and X → null (logout).
export function shouldInvalidateOnDistributorSwitch(
  prev: string | null,
  current: string | null,
  isSuperAdmin: boolean,
): boolean {
  if (!isSuperAdmin) return false;
  return prev !== current;
}
