---
description: Security review of all changes — OWASP + multi-tenant checks
---

# Secure — ADLC Framework

Reviews ALL code changes since last commit. Outputs security-review.md.
Blocks ship on any HIGH or CRITICAL finding.

## Step 1: Get Changed Code

```bash
git diff HEAD 2>/dev/null || git diff --cached
git diff HEAD~1 --name-only
```

## Step 2: Run Automated Scans

```bash
./scripts/security/security-scan.sh
```

## Step 3: Manual Code Review Checklist

Review every changed file against this checklist:

### A01 — Broken Access Control
- [ ] Every new endpoint has auth check
- [ ] No route accessible without authentication (unless explicitly public API)
- [ ] Data fetches use: `WHERE id = ? AND tenant_id = ?` (multi-tenant projects)
- [ ] No IDOR — user cannot access other users' resources by changing an ID

### A02 — Cryptographic Failures
- [ ] No sensitive data (passwords, tokens, PII) in URLs, logs, or error responses
- [ ] Passwords use bcrypt/argon2 — never MD5, SHA1, or plaintext
- [ ] Tokens/secrets minimum 32 characters, cryptographically random

### A03 — Injection
- [ ] Zero raw SQL string concatenation — parameterised queries ONLY
- [ ] No `eval()`, `exec()`, or dynamic code execution
- [ ] No OS command injection via user input (`subprocess`, `os.system`)
- [ ] Template injection: no user input directly in template strings

### A04 — Insecure Design
- [ ] Rate limiting on: login, register, password reset, OTP, order placement
- [ ] Sensitive operations require re-authentication if needed
- [ ] No sensitive data in client-side storage (localStorage for tokens = bad)

### A05 — Security Misconfiguration
- [ ] CORS: specific origins only, not `*` in production
- [ ] Debug mode off in production
- [ ] Security headers present: CSP, HSTS, X-Frame-Options, X-Content-Type-Options

### A07 — Auth & Session Failures
- [ ] JWT: signature verified, expiry checked, issuer checked — on EVERY request
- [ ] Firebase: ID token verified server-side — never trust client-decoded claims
- [ ] Sessions expire and are invalidated on logout server-side
- [ ] No JWT secrets shorter than 64 characters

### A08 — Software & Data Integrity
- [ ] No new packages added without review
- [ ] File uploads: whitelist valid types, reject executable files

### Multi-Tenant (applies to all multi-tenant projects) ⚠️
- [ ] `tenant_id` sourced ONLY from JWT/session — never from request body
- [ ] ALL queries on tenant-scoped tables filter by `tenant_id`
- [ ] Cross-tenant data access is impossible — verify with test
- [ ] New tables: does tenant isolation apply? If yes, `tenant_id` column + index added?

### XSS
- [ ] React: no `dangerouslySetInnerHTML` without DOMPurify sanitisation
- [ ] No user content rendered as raw HTML anywhere
- [ ] CSP header blocks inline scripts

### Financial Data (ERP projects)
- [ ] Monetary values stored as integers (paise not rupees)
- [ ] GST/invoice records cannot be silently edited — append-only or audit trail
- [ ] Every financial mutation has audit log entry

## Step 4: Write security-review.md

```markdown
# Security Review — [item-id]
Date: [date]
Reviewer: SECURE_AGENT

## Result: [APPROVED | BLOCKED]

## Findings
| Category | File:Line | Severity | Status |
|---|---|---|---|
| [finding] | [file:line] | [LOW/MED/HIGH/CRIT] | [resolved/unresolved] |

## Approved If
All HIGH/CRITICAL findings are resolved.
```

## Step 5: Block or Approve

- Any unresolved HIGH or CRITICAL → output `SECURITY=BLOCKED`, do not proceed to /review
- All clear or only LOW/MEDIUM → output `SECURITY=APPROVED`
- Send Telegram if BLOCKED: `🔴 [PROJECT] — Security blocked: [finding summary]`
