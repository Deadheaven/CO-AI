#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 user@nebius-vm" >&2
  exit 2
fi

host="$1"
remote_dir="/opt/co-ai"

ssh -t "$host" "sudo mkdir -p '$remote_dir' && sudo chown \$(id -u):\$(id -g) '$remote_dir'"
tar \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=dist \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.env.nebius' \
  --exclude='worker/.env.worker' \
  --exclude='**/.env' \
  --exclude='**/.env.local' \
  --exclude='**/.env.nebius' \
  --exclude='**/.env.worker' \
  --exclude=supabase/.temp \
  --exclude='**/__pycache__' \
  -czf - . | ssh "$host" "tar -xzf - -C '$remote_dir'"

ssh -t "$host" "cd '$remote_dir' && test -f .env.nebius && test -f worker/.env.worker && docker compose --env-file .env.nebius --env-file worker/.env.worker -f compose.worker.yaml up -d --build"
