#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

ROOT="${RESUME_AI_ROOT:-/home/heqing/resume-ai}"
TOKEN_FILE="$ROOT/run/embedding.token"
[[ -f "$TOKEN_FILE" && ! -L "$TOKEN_FILE" ]] || { printf 'embedding token file is missing or unsafe\n' >&2; exit 1; }
[[ "$(stat -c '%a' -- "$TOKEN_FILE")" == 600 ]] || { printf 'embedding token file must have mode 0600\n' >&2; exit 1; }
[[ "$(wc -l < "$TOKEN_FILE")" == 1 && "$(wc -c < "$TOKEN_FILE")" == 65 ]] \
  || { printf 'embedding token file is invalid\n' >&2; exit 1; }
token=""
IFS= read -r token < "$TOKEN_FILE" || true
[[ "$token" =~ ^[A-Za-z0-9_-]{64}$ ]] || { printf 'embedding token file is invalid\n' >&2; exit 1; }
unset token

export CUDA_VISIBLE_DEVICES=5
export EMBEDDING_DEVICE=cuda:0
export EMBEDDING_HOST=127.0.0.1
export EMBEDDING_PORT=18080
export EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B
export EMBEDDING_MODEL_REVISION=1d8ad4ca9b3dd8059ad90a75d4983776a23d44af
export EMBEDDING_DIMENSIONS=4096
export EMBEDDING_MODEL_PATH="$ROOT/current/models/Qwen3-Embedding-8B"
export EMBEDDING_API_TOKEN_FILE="$TOKEN_FILE"
export HF_HOME="$ROOT/cache/huggingface"
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export PYTHONUNBUFFERED=1

exec "$ROOT/envs/embedding/bin/python" -m resume_embedding_worker.main
