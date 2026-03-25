#!/bin/bash
# GasLink Database Backup Script
# Usage: ./scripts/backup.sh [output_dir]
#
# Environment variables:
#   DATABASE_URL - PostgreSQL connection string (required)
#   BACKUP_RETENTION_DAYS - Days to keep old backups (default: 30)

set -euo pipefail

BACKUP_DIR="${1:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/gaslink_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

# Extract connection details from DATABASE_URL
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL environment variable is required"
  echo "Example: postgresql://user:pass@host:5432/dbname"
  exit 1
fi

echo "Starting backup at $(date)..."
echo "Output: ${BACKUP_FILE}"

# Use pg_dump with gzip compression
pg_dump "$DATABASE_URL" --no-owner --no-acl --clean --if-exists | gzip > "$BACKUP_FILE"

FILESIZE=$(ls -lh "$BACKUP_FILE" | awk '{print $5}')
echo "Backup complete: ${BACKUP_FILE} (${FILESIZE})"

# Clean old backups
if [ "$RETENTION_DAYS" -gt 0 ]; then
  DELETED=$(find "$BACKUP_DIR" -name "gaslink_*.sql.gz" -mtime +"$RETENTION_DAYS" -delete -print | wc -l)
  if [ "$DELETED" -gt 0 ]; then
    echo "Cleaned ${DELETED} backups older than ${RETENTION_DAYS} days"
  fi
fi

echo "Backup finished at $(date)"
