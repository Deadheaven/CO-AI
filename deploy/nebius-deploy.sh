#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 user@nebius-vm [all|worker-only]" >&2
  exit 2
fi

host="$1"
mode="${2:-all}"
remote_dir="/opt/co-ai"

if [[ "$mode" != "all" && "$mode" != "worker-only" ]]; then
  echo "Deployment mode must be 'all' or 'worker-only'." >&2
  exit 2
fi

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

if [[ "$mode" == "worker-only" ]]; then
  remote_command="cd '$remote_dir' && test -f worker/.env.worker && chmod 600 worker/.env.worker && docker compose --env-file worker/.env.worker -f compose.worker-only.yaml up -d --build"
else
  remote_command="cd '$remote_dir' && test -f .env.nebius && test -f worker/.env.worker && chmod 600 .env.nebius worker/.env.worker && docker compose --env-file .env.nebius --env-file worker/.env.worker -f compose.worker.yaml up -d --build"
fi
ssh -t "$host" "$remote_command"
