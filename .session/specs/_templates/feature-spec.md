# [item-id]: [Feature Title]
Type: feature
Priority: [critical|high|medium|low]
Created: [YYYY-MM-DD]
Dependencies: [item-ids or none]

---

## Overview
[2-3 sentences: what this feature does, why it's needed, user impact]

## User Story
As a [role], I want [goal] so that [benefit].

## Acceptance Criteria
<!-- Minimum 5 — each must be specific and measurable. NO vague criteria. -->
- [ ] [Specific, testable criterion 1]
- [ ] [Specific, testable criterion 2]
- [ ] [Specific, testable criterion 3]
- [ ] [Specific, testable criterion 4]
- [ ] [Specific, testable criterion 5]

## Out of Scope
<!-- Explicitly state what will NOT be done -->
- 

## Implementation Details

### Approach
[How will this be built? Step by step.]

### Components / Files Affected
- `[file path]` — [what changes]
- `[file path]` — [what changes]

### API Changes
<!-- Full request/response contracts for any new/changed endpoints -->
```
POST /api/v1/[resource]
Auth: required
Request: { }
Response: { }
Error cases: { }
```

### Database Changes
```sql
-- Full SQL for any schema changes
-- Include indexes
```

### Multi-Tenant Considerations
<!-- How does tenant isolation apply to this feature? -->
- All queries filter by `tenant_id` from JWT: [yes/N/A]
- New tables tenant-scoped: [yes/no — list tables]
- Cross-tenant risk: [describe any risk and mitigation]

### Auth & Permissions
- Requires auth: [yes/no]
- Required role(s): [e.g. admin, user, any]
- Permission check location: [e.g. router dependency / service layer]

### Error Handling
- [Error scenario 1] → [response]
- [Error scenario 2] → [response]

## Testing Strategy

### Unit Tests
- [What to test at unit level]

### Integration Tests
- [API endpoint tests — happy path and error cases]

### E2E Scenarios
1. [Full user flow 1]
2. [Full user flow 2]

### Edge Cases
- [Edge case 1]
- [Edge case 2]

## Security Checklist
- [ ] Input validated and sanitised
- [ ] All DB queries parameterised
- [ ] Auth checked on all new endpoints
- [ ] tenant_id enforced on all tenant-scoped queries
- [ ] No sensitive data in logs or error responses
- [ ] Rate limiting applied where needed
