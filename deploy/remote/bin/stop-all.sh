#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

ROOT="${RESUME_AI_ROOT:-/home/heqing/resume-ai}"
exec python3 "$ROOT/services/deployment.py" stop --root "$ROOT"
