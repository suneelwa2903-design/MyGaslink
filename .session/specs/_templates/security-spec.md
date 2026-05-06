# [item-id]: [Security Issue Title]
Type: security
Priority: critical  <!-- security items default to critical — downgrade only with justification -->
Created: [YYYY-MM-DD]
Dependencies: [item-ids or none]

---

## Security Issue
[Clear description of the vulnerability or security gap]

## Severity
- [ ] Critical — active exploit possible, data breach risk
- [ ] High — significant risk, likely exploitable
- [ ] Medium — possible exploit, moderate impact
- [ ] Low — hardening / best practice

**CVSS Score (if applicable):** [score]
**OWASP Category:** [e.g. A01 Broken Access Control]

## Affected Components
- Endpoint/route: [path]
- File: [path]
- Data at risk: [what data could be exposed/modified]
- Affected versions: [version range]

## Threat Model

### Who Could Exploit This
[External attacker / authenticated user / insider]

### Attack Scenario
```
[Step by step how an attacker would exploit this]
```

**Proof of Concept (safe to document):**
```bash
[curl command or code snippet showing the exploit]
```

## Mitigation

### Primary Fix
[Main fix — be specific with code]

```python
# Before (vulnerable):
[code]

# After (secure):
[code]
```

### Defence in Depth
1. [Additional control 1]
2. [Additional control 2]

## Acceptance Criteria
- [ ] Vulnerability is fully remediated
- [ ] All attack scenarios in threat model are mitigated
- [ ] Security tests added covering the attack vector
- [ ] No regression in functionality
- [ ] ARCHITECTURE.md security notes updated

## Security Testing
- [ ] Manual test: attempt exploit after fix — confirm it fails
- [ ] Automated test: test case that would catch regression
- [ ] Dependency scan run: no new HIGH/CRITICAL findings

## Post-Deployment
- [ ] Monitor logs for exploit attempts for 7 days
- [ ] Rotate any potentially compromised secrets
- [ ] Notify affected users if data may have been exposed
