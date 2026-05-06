# Spec — {WORK_ITEM_TITLE}

**ID:** {WI-NNN}
**Created:** {YYYY-MM-DD}
**Owner:** {name}
**Status:** draft | in-progress | review | done | blocked
**Priority:** P0 | P1 | P2 | P3

## Problem
{One paragraph: what user/system problem are we solving, and why now.}

## Goals
- {bullet}

## Non-goals
- {bullet — what we're explicitly NOT doing}

## Constraints
- Multi-tenant: must respect `distributorId` isolation
- Backwards-compat: {breaking change? migration plan?}
- GST: {affects gstMode flows?}
- Roles affected: {SUPER_ADMIN | DISTRIBUTOR_ADMIN | FINANCE | INVENTORY | DRIVER | CUSTOMER}

## Approach
{High-level design. Reference files, models, routes that will change.}

## Schema changes
- {table.column → type, default, FK} or "none"

## API changes
- {METHOD /api/path — request/response shape} or "none"

## UI changes
- {page/component — behaviour change} or "none"

## Tests
- Unit:
- Integration ([packages/api/src/__tests__/](../../packages/api/src/__tests__/)):
- Manual E2E (add to `docs/E2E_Testing_Guide.xlsx`):

## Rollout
- Migration order:
- Feature flag / env var:
- Monitoring / alerts:

## Open questions
- [ ] {question — owner}
