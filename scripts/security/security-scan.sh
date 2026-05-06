#!/bin/bash
# ADLC Framework — Security Hardening Check
# Runs available security tools and reports findings
# Add to pre-commit hook or run manually before /session-end

ALERT="$(dirname $0)/../alerts/telegram.sh"
PROJECT="${PROJECT_NAME:-$(basename $(pwd))}"
REPORT_FILE="/tmp/security-report-$(date +%Y%m%d-%H%M%S).txt"
HIGH_FINDINGS=0

echo "SECURITY SCAN — ${PROJECT}" > "$REPORT_FILE"
echo "$(date)" >> "$REPORT_FILE"
echo "═══════════════════════════════" >> "$REPORT_FILE"

# ─── Python: Bandit (SAST) ────────────────────────────────────────────
if command -v bandit &>/dev/null && [ -f "requirements.txt" ]; then
  echo "" >> "$REPORT_FILE"
  echo "[ BANDIT — Python SAST ]" >> "$REPORT_FILE"
  bandit -r . -ll --exclude ./tests,./venv,./.venv -f txt 2>&1 >> "$REPORT_FILE"
  
  HIGH_COUNT=$(bandit -r . -ll --exclude ./tests,./venv,./.venv -f json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for i in d.get('results',[]) if i['issue_severity'] in ['HIGH','CRITICAL']))" 2>/dev/null || echo 0)
  HIGH_FINDINGS=$((HIGH_FINDINGS + HIGH_COUNT))
fi

# ─── Python: Safety (dependency vulnerabilities) ──────────────────────
if command -v safety &>/dev/null && [ -f "requirements.txt" ]; then
  echo "" >> "$REPORT_FILE"
  echo "[ SAFETY — Python Dependencies ]" >> "$REPORT_FILE"
  safety check 2>&1 >> "$REPORT_FILE"
fi

# ─── Node: npm audit ──────────────────────────────────────────────────
if [ -f "package.json" ]; then
  echo "" >> "$REPORT_FILE"
  echo "[ NPM AUDIT — Node Dependencies ]" >> "$REPORT_FILE"
  npm audit --audit-level=high 2>&1 >> "$REPORT_FILE"
  
  NPM_HIGH=$(npm audit --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); v=d.get('metadata',{}).get('vulnerabilities',{}); print(v.get('high',0)+v.get('critical',0))" 2>/dev/null || echo 0)
  HIGH_FINDINGS=$((HIGH_FINDINGS + NPM_HIGH))
fi

# ─── Secret Detection ─────────────────────────────────────────────────
echo "" >> "$REPORT_FILE"
echo "[ SECRET DETECTION ]" >> "$REPORT_FILE"

SECRET_PATTERNS=(
  "password\s*=\s*['\"][^'\"]{4,}"
  "secret\s*=\s*['\"][^'\"]{4,}"
  "api_key\s*=\s*['\"][^'\"]{4,}"
  "token\s*=\s*['\"][^'\"]{4,}"
  "PRIVATE KEY"
  "BEGIN RSA"
)

SECRET_FOUND=0
for pattern in "${SECRET_PATTERNS[@]}"; do
  MATCHES=$(grep -rn --include="*.py" --include="*.js" --include="*.ts" --include="*.env" \
    -i "$pattern" . \
    --exclude-dir=".git" --exclude-dir="node_modules" --exclude-dir="venv" --exclude-dir=".venv" \
    2>/dev/null | grep -v "test\|example\|#\|//\|\.example")
  
  if [ -n "$MATCHES" ]; then
    echo "⚠️  Possible secret: $pattern" >> "$REPORT_FILE"
    echo "$MATCHES" >> "$REPORT_FILE"
    SECRET_FOUND=1
    HIGH_FINDINGS=$((HIGH_FINDINGS + 1))
  fi
done

if [ "$SECRET_FOUND" -eq 0 ]; then
  echo "✅ No obvious secrets detected" >> "$REPORT_FILE"
fi

# ─── Multi-Tenant Safety Check ────────────────────────────────────────
if grep -r "multi-tenant: yes" CLAUDE.md &>/dev/null 2>&1; then
  echo "" >> "$REPORT_FILE"
  echo "[ MULTI-TENANT ISOLATION CHECK ]" >> "$REPORT_FILE"
  
  # Look for queries without tenant_id filter
  UNSAFE=$(grep -rn --include="*.py" "filter\|where\|SELECT" . \
    --exclude-dir=".git" --exclude-dir="venv" --exclude-dir="tests" \
    2>/dev/null | grep -v "tenant_id\|#\|test_\|migration" | head -20)
  
  if [ -n "$UNSAFE" ]; then
    echo "⚠️  Possible queries without tenant_id filter — review manually:" >> "$REPORT_FILE"
    echo "$UNSAFE" >> "$REPORT_FILE"
  else
    echo "✅ Spot check passed" >> "$REPORT_FILE"
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────
echo "" >> "$REPORT_FILE"
echo "═══════════════════════════════" >> "$REPORT_FILE"
echo "HIGH/CRITICAL FINDINGS: ${HIGH_FINDINGS}" >> "$REPORT_FILE"

cat "$REPORT_FILE"

if [ "$HIGH_FINDINGS" -gt 0 ]; then
  $ALERT "🔴 SECURITY SCAN FAILED — ${PROJECT}
${HIGH_FINDINGS} HIGH/CRITICAL finding(s)
Fix before shipping. Run: /secure"
  exit 1
fi

echo "✅ Security scan passed"
exit 0
