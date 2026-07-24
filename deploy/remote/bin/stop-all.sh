#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

ROOT="${RESUME_AI_ROOT:-/home/heqing/resume-ai}"
stopped=0

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user stop resume-embedding.service resume-ocr.service 2>/dev/null || true
  stopped=1
fi

supervisorctl="$ROOT/envs/embedding/bin/supervisorctl"
if [[ -x "$supervisorctl" && -S "$ROOT/run/supervisor.sock" && ! -L "$ROOT/run/supervisor.sock" ]]; then
  RESUME_AI_ROOT="$ROOT" "$supervisorctl" -c "$ROOT/services/supervisord.conf" shutdown
  stopped=1
fi

if (( stopped == 0 )); then
  printf 'No supported worker supervisor is running.\n'
else
  printf 'Worker stop requested.\n'
fi
