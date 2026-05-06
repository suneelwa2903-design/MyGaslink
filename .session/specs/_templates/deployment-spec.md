# [item-id]: [Deployment Title]
Type: deployment
Priority: [critical|high|medium]
Created: [YYYY-MM-DD]
Dependencies: [all feature/bug items being deployed]

---

## Deployment Scope
[What is being deployed — list features/fixes included]

## Target Environment
- Environment: [staging | production]
- Server: [IP / hostname / AWS resource]
- Deployment method: [git pull + restart | Docker pull | CI/CD pipeline]

## Pre-Deployment Checklist
- [ ] All included work items have status = `completed`
- [ ] All tests passing on main branch
- [ ] Security scan clean (no HIGH/CRITICAL)
- [ ] Database migrations tested on staging first
- [ ] Environment variables updated if new ones added
- [ ] Backup taken of production database
- [ ] Rollback procedure documented below

## Database Migrations
```bash
# List all migration files being applied
# Example:
alembic upgrade head
# or: python manage.py migrate
```

**Migration risks:** [any data changes, column drops, schema changes that are hard to reverse]

## Deployment Steps
```bash
# Step by step — exact commands
1. ssh user@server
2. cd /path/to/project
3. git pull origin main
4. pip install -r requirements.txt  # or npm install
5. alembic upgrade head
6. systemctl restart [service-name]
# or: docker-compose pull && docker-compose up -d
```

## Smoke Tests (run immediately after deploy)
- [ ] [Health check endpoint responds 200]
- [ ] [Login works]
- [ ] [Key feature X works]
- [ ] [Check logs for errors: tail -f /var/log/app/error.log]

## Rollback Procedure
```bash
# If smoke tests fail:
1. git checkout [previous-commit-hash]
2. alembic downgrade -1  # if migrations applied
3. systemctl restart [service-name]
4. Verify rollback successful
5. Send Telegram: 🔴 [PROJECT] — deployment rolled back
```

**Rollback trigger:** [define what failure state triggers rollback — e.g. >5% error rate, smoke test failure]

## Post-Deployment
- [ ] Monitor error logs for 30 minutes
- [ ] Check Telegram for any alerts
- [ ] Confirm key metrics normal
- [ ] Send Telegram: ✅ [PROJECT] — v[X.X] deployed successfully
