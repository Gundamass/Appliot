#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  TEST_ROOT="$BATS_TEST_TMPDIR/resume-ai"
  BUNDLE="$BATS_TEST_TMPDIR/bundle"
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  export PATH="$STUB_BIN:/usr/bin:/bin"
  export HOME="$BATS_TEST_TMPDIR/home"
  mkdir -p "$HOME"
}

@test "installer refuses a model checksum mismatch before creating environments" {
  make_bundle
  printf 'corrupt\n' > "$BUNDLE/models/Qwen3-Embedding-8B/config.json"
  stub_install_preflight

  run "$REPO_ROOT/deploy/remote/install.sh" --root "$TEST_ROOT" --bundle "$BUNDLE"

  [ "$status" -ne 0 ]
  [[ "$output" == *"hash mismatch"* ]]
  [ ! -e "$TEST_ROOT/envs/embedding" ]
  [ ! -e "$BATS_TEST_TMPDIR/conda-create-called" ]
}

@test "run scripts pin physical GPU 5, cuda zero, and loopback listeners" {
  run grep -E 'CUDA_VISIBLE_DEVICES=5' "$REPO_ROOT/deploy/remote/bin/run-embedding.sh"
  [ "$status" -eq 0 ]
  run grep -E 'EMBEDDING_HOST=127\.0\.0\.1' "$REPO_ROOT/deploy/remote/bin/run-embedding.sh"
  [ "$status" -eq 0 ]
  run grep -E 'EMBEDDING_DEVICE=cuda:0' "$REPO_ROOT/deploy/remote/bin/run-embedding.sh"
  [ "$status" -eq 0 ]
  run grep -E 'OCR_HOST=127\.0\.0\.1' "$REPO_ROOT/deploy/remote/bin/run-ocr.sh"
  [ "$status" -eq 0 ]
  run grep -E 'OCR_DEVICE=cuda:0' "$REPO_ROOT/deploy/remote/bin/run-ocr.sh"
  [ "$status" -eq 0 ]
}

@test "installer rejects managed directory symlinks before Conda mutation" {
  make_bundle
  stub_install_preflight
  outside="$BATS_TEST_TMPDIR/outside"
  mkdir -p "$TEST_ROOT" "$outside"
  ln -s "$outside" "$TEST_ROOT/releases"

  run "$REPO_ROOT/deploy/remote/install.sh" --root "$TEST_ROOT" --bundle "$BUNDLE"

  [ "$status" -ne 0 ]
  [[ "$output" == *"unsafe managed directory"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/conda-create-called" ]
  [ -z "$(find "$outside" -mindepth 1 -print -quit)" ]
}

@test "run scripts reject token files that are not mode 0600" {
  mkdir -p "$TEST_ROOT/run"
  printf 'not-a-real-secret\n' > "$TEST_ROOT/run/embedding.token"
  chmod 0644 "$TEST_ROOT/run/embedding.token"

  run env RESUME_AI_ROOT="$TEST_ROOT" "$REPO_ROOT/deploy/remote/bin/run-embedding.sh"

  [ "$status" -ne 0 ]
  [[ "$output" == *"mode 0600"* ]]
  [[ "$output" != *"not-a-real-secret"* ]]
}

@test "start-all falls back to supervisor without putting tokens in argv" {
  mkdir -p "$TEST_ROOT/envs/embedding/bin" "$TEST_ROOT/services"
  cp "$REPO_ROOT/deploy/remote/supervisord.conf" "$TEST_ROOT/services/supervisord.conf"
  cat > "$TEST_ROOT/envs/embedding/bin/supervisord" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$SUPERVISOR_ARGS"
SH
  chmod +x "$TEST_ROOT/envs/embedding/bin/supervisord"
  cat > "$STUB_BIN/systemctl" <<'SH'
#!/usr/bin/env bash
exit 1
SH
  chmod +x "$STUB_BIN/systemctl"
  export SUPERVISOR_ARGS="$BATS_TEST_TMPDIR/supervisor-args"

  run env RESUME_AI_ROOT="$TEST_ROOT" "$REPO_ROOT/deploy/remote/bin/start-all.sh"

  [ "$status" -eq 0 ]
  grep -Fx -- '-c' "$SUPERVISOR_ARGS"
  ! grep -E 'token|secret|Bearer' "$SUPERVISOR_ARGS"
}

@test "control scripts do not trust stale supervisor pid files" {
  run grep -E 'kill -(0|TERM|KILL)' "$REPO_ROOT/deploy/remote/bin/start-all.sh" \
    "$REPO_ROOT/deploy/remote/bin/stop-all.sh"
  [ "$status" -ne 0 ]
}

@test "installer rejects traversal in the installation root" {
  make_bundle
  stub_install_preflight

  run "$REPO_ROOT/deploy/remote/install.sh" \
    --root "$BATS_TEST_TMPDIR/root/../escape" --bundle "$BUNDLE"

  [ "$status" -ne 0 ]
  [[ "$output" == *"must not contain traversal"* ]]
  [ ! -e "$BATS_TEST_TMPDIR/conda-create-called" ]
}

make_bundle() {
  mkdir -p \
    "$BUNDLE/workers/embedding-worker/wheelhouse" \
    "$BUNDLE/workers/ocr-worker/wheelhouse" \
    "$BUNDLE/models/Qwen3-Embedding-8B" \
    "$BUNDLE/models/DeepSeek-OCR-2"
  printf 'fixture wheel' > "$BUNDLE/workers/embedding-worker/wheelhouse/resume_embedding_worker-0.1.0-py3-none-any.whl"
  printf 'fixture wheel' > "$BUNDLE/workers/ocr-worker/wheelhouse/resume_ocr_worker-0.1.0-py3-none-any.whl"
  printf '%s\n' '--require-hashes' 'fastapi==0.115.12 \' '    --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' > "$BUNDLE/workers/embedding-worker/requirements.lock"
  cp "$BUNDLE/workers/embedding-worker/requirements.lock" "$BUNDLE/workers/ocr-worker/requirements.lock"
  printf '{"fixture":true}\n' > "$BUNDLE/models/Qwen3-Embedding-8B/config.json"
  printf 'weights' > "$BUNDLE/models/Qwen3-Embedding-8B/weights.bin"
  printf '{"fixture":true}\n' > "$BUNDLE/models/DeepSeek-OCR-2/config.json"
  printf 'weights' > "$BUNDLE/models/DeepSeek-OCR-2/weights.bin"
  printf '# reviewed\n' > "$BUNDLE/models/DeepSeek-OCR-2/modeling_deepseekocr.py"
  write_manifests
}

write_manifests() {
  python3 - "$BUNDLE" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

bundle = Path(sys.argv[1])
def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

for directory, worker, version, wheel in (
    ("embedding-worker", "resume-embedding-worker", "3.10", "resume_embedding_worker-0.1.0-py3-none-any.whl"),
    ("ocr-worker", "resume-ocr-worker", "3.12", "resume_ocr_worker-0.1.0-py3-none-any.whl"),
):
    root = bundle / "workers" / directory
    paths = ["requirements.lock", f"wheelhouse/{wheel}"]
    manifest = {
        "worker": worker,
        "python": version,
        "wheel": f"wheelhouse/{wheel}",
        "files": [{"path": path, "sha256": digest(root / path)} for path in paths],
    }
    (root / "worker-manifest.json").write_text(json.dumps(manifest))

models = (
    ("Qwen3-Embedding-8B", "Qwen/Qwen3-Embedding-8B", "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af", False),
    ("DeepSeek-OCR-2", "deepseek-ai/DeepSeek-OCR-2", "aaa02f3811945a91062062994c5c4a3f4c0af2b0", True),
)
for directory, model, revision, custom in models:
    root = bundle / "models" / directory
    paths = ["config.json", "weights.bin"]
    manifest = {"model": model, "revision": revision}
    if directory == "Qwen3-Embedding-8B":
        manifest["dimensions"] = 4096
    if custom:
        paths.append("modeling_deepseekocr.py")
        manifest["verificationStatus"] = "verified"
        manifest["customCodeFiles"] = ["modeling_deepseekocr.py"]
    manifest["files"] = [{"path": path, "sha256": digest(root / path)} for path in paths]
    (root / "model-manifest.json").write_text(json.dumps(manifest))
PY
}

stub_install_preflight() {
  cat > "$STUB_BIN/uname" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  -s) printf 'Linux\n' ;;
  -m) printf 'x86_64\n' ;;
  *) printf 'Linux\n' ;;
esac
SH
  cat > "$STUB_BIN/id" <<'SH'
#!/usr/bin/env bash
printf 'heqing\n'
SH
  cat > "$STUB_BIN/nvidia-smi" <<'SH'
#!/usr/bin/env bash
printf '0\n1\n2\n3\n4\n5\n'
SH
  cat > "$STUB_BIN/df" <<'SH'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 300000000 1 200000000 1%% /\n'
SH
  cat > "$STUB_BIN/conda" <<SH
#!/usr/bin/env bash
if [[ "\${1:-}" == search ]]; then
  printf '{"python": [{"version": "fixture"}]}\n'
  exit 0
fi
if [[ "\${1:-}" == create ]]; then
  touch '$BATS_TEST_TMPDIR/conda-create-called'
fi
exit 0
SH
  chmod +x "$STUB_BIN"/*
  export RESUME_AI_OS_RELEASE="$BATS_TEST_TMPDIR/os-release"
  printf 'ID=ubuntu\nVERSION_ID="20.04"\n' > "$RESUME_AI_OS_RELEASE"
}
