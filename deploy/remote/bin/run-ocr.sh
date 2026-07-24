#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

ROOT="${RESUME_AI_ROOT:-/home/heqing/resume-ai}"
TOKEN_FILE="$ROOT/run/ocr.token"
[[ -f "$TOKEN_FILE" && ! -L "$TOKEN_FILE" ]] || { printf 'OCR token file is missing or unsafe\n' >&2; exit 1; }
[[ "$(stat -c '%a' -- "$TOKEN_FILE")" == 600 ]] || { printf 'OCR token file must have mode 0600\n' >&2; exit 1; }
[[ "$(wc -l < "$TOKEN_FILE")" == 1 && "$(wc -c < "$TOKEN_FILE")" == 65 ]] \
  || { printf 'OCR token file is invalid\n' >&2; exit 1; }
token=""
IFS= read -r token < "$TOKEN_FILE" || true
[[ "$token" =~ ^[A-Za-z0-9_-]{64}$ ]] || { printf 'OCR token file is invalid\n' >&2; exit 1; }
unset token

export CUDA_VISIBLE_DEVICES=5
export OCR_DEVICE=cuda:0
export OCR_HOST=127.0.0.1
export OCR_PORT=43121
export OCR_MODEL=deepseek-ai/DeepSeek-OCR-2
export OCR_MODEL_REVISION=aaa02f3811945a91062062994c5c4a3f4c0af2b0
export OCR_MODEL_PATH="$ROOT/current/models/DeepSeek-OCR-2"
export OCR_API_TOKEN_FILE="$TOKEN_FILE"
export OCR_TEMP_DIR="$ROOT/tmp"
export HF_HOME="$ROOT/cache/huggingface"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export PYTHONUNBUFFERED=1

exec "$ROOT/envs/ocr/bin/python" -m resume_ocr_worker.main
