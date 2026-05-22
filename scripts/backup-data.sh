#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="$ROOT_DIR/data/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/reviewos-data-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"
tar --exclude='data/backups' -czf "$DEST" -C "$ROOT_DIR" data

echo "$DEST"
