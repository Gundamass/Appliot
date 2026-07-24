#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

ROOT="${RESUME_AI_ROOT:-/home/heqing/resume-ai}"
export RESUME_AI_ROOT="$ROOT"

systemd_available() {
  command -v systemctl >/dev/null 2>&1 \
    && command -v loginctl >/dev/null 2>&1 \
    && systemctl --user show-environment >/dev/null 2>&1 \
    && [[ "$(loginctl show-user "$(id -un)" --property=Linger --value 2>/dev/null)" == yes ]]
}

if [[ "$ROOT" == /home/heqing/resume-ai ]] && systemd_available; then
  unit_directory="$HOME/.config/systemd/user"
  umask 077
  mkdir -p -- "$unit_directory"
  install -m 600 -- "$ROOT/services/systemd/resume-embedding.service" \
    "$ROOT/services/systemd/resume-ocr.service" "$unit_directory/"
  systemctl --user daemon-reload
  systemctl --user enable --now resume-embedding.service resume-ocr.service
  printf 'Started workers with user systemd.\n'
  exit 0
fi

supervisord="$ROOT/envs/embedding/bin/supervisord"
supervisorctl="$ROOT/envs/embedding/bin/supervisorctl"
[[ -x "$supervisord" ]] || { printf 'Supervisor is unavailable in the embedding environment.\n' >&2; exit 1; }
if [[ -x "$supervisorctl" && -S "$ROOT/run/supervisor.sock" && ! -L "$ROOT/run/supervisor.sock" ]] \
  && "$supervisorctl" -c "$ROOT/services/supervisord.conf" status >/dev/null 2>&1; then
  printf 'Workers are already managed by Supervisor.\n'
  exit 0
fi
"$supervisord" -c "$ROOT/services/supervisord.conf"
printf 'Started workers with Supervisor.\n'
