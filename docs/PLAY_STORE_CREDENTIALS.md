# Play Console — App Access Credentials

## Demo Distributor (Production Testing)

Use these for Google Play review testing.

**URL:** https://mygaslink.com

| Role | Email | Password |
|------|-------|----------|
| Admin | `demo@gasdist.com` | `Demo@Admin123` |
| Finance | `demo.finance@gasdist.com` | `Demo@Finance123` |
| Inventory | `demo.inventory@gasdist.com` | `Demo@Inventory123` |
| Driver | `demo.driver@gasdist.com` | `Demo@Driver123` |
| Customer | `demo.customer@gasdist.com` | `Demo@Customer123` |

> **Spec note (2026-05-29):** The original task spec listed
> `sharma@gasdist.com` as the demo Admin login, but that email already
> belongs to the dist-002 distributor_admin in `seed.ts`. `User.email` is
> globally `@unique`, so reusing it would have flipped the existing user's
> `distributorId` from `dist-002` to `dist-demo` and broken the dist-002
> admin login. The seed script uses `demo@gasdist.com / Demo@Admin123`
> instead, matching the "all user emails use demo@... pattern" rule in
> the same spec's CRITICAL RULES.

Seeded by `pnpm --filter @gaslink/api seed:demo` (idempotent — safe to
re-run).

## Sharma dist-002 (Dev/QA)

Internal testing only — not for Play Store review.

| Role | Email | Password |
|------|-------|----------|
| Admin | `sharma@gasdist.com` | `Gstadmin@123` |
| Finance | `finance2@gasdist.com` | `Finance@123` |
| Inventory | `inventory2@gasdist.com` | `Inventory@123` |
| Driver | `driver2@gasdist.com` | `Driver@123` |
| Customer | `customer2@gasdist.com` | `Customer@123` |
