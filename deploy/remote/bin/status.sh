#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

ROOT="${RESUME_AI_ROOT:-/home/heqing/resume-ai}"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 \
  && systemctl --user status resume-embedding.service resume-ocr.service --no-pager; then
  exit 0
fi

supervisorctl="$ROOT/envs/embedding/bin/supervisorctl"
if [[ -x "$supervisorctl" && -S "$ROOT/run/supervisor.sock" && ! -L "$ROOT/run/supervisor.sock" ]]; then
  exec env RESUME_AI_ROOT="$ROOT" "$supervisorctl" -c "$ROOT/services/supervisord.conf" status
fi

printf 'Workers are not running under user systemd or Supervisor.\n' >&2
exit 1
