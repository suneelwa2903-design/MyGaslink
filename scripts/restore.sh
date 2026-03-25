#!/bin/bash
# GasLink Database Restore Script
# Usage: ./scripts/restore.sh <backup_file>
#
# Environment variables:
#   DATABASE_URL - PostgreSQL connection string (required)

set -euo pipefail

BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: ./scripts/restore.sh <backup_file.sql.gz>"
  echo ""
  echo "Available backups:"
  ls -lht backups/gaslink_*.sql.gz 2>/dev/null || echo "  No backups found in ./backups/"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found: ${BACKUP_FILE}"
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL environment variable is required"
  exit 1
fi

echo "╔══════════════════════════════════════════════╗"
echo "║  WARNING: This will REPLACE all data in the ║"
echo "║  target database with the backup contents.   ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Backup file: ${BACKUP_FILE}"
echo "Target: ${DATABASE_URL%%@*}@..."
echo ""
read -p "Are you sure? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled."
  exit 0
fi

echo "Restoring from ${BACKUP_FILE}..."
gunzip -c "$BACKUP_FILE" | psql "$DATABASE_URL" --quiet

echo "Restore complete at $(date)"
echo "Run 'pnpm --filter @gaslink/api run db:migrate:prod' if migrations are pending."
