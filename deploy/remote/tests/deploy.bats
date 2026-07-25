#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  TEST_ROOT="$BATS_TEST_TMPDIR/resume-ai"
  BUNDLE="$BATS_TEST_TMPDIR/bundle"
  STUB_BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$STUB_BIN"
  export PATH="$STUB_BIN:/usr/bin:/bin"
  export HOME="$BATS_TEST_TMPDIR/home"
  export RESUME_AI_MIN_FREE_KIB=1
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
  [[ "$output" == *"managed directory"* ]]
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

@test "successful first install starts and verifies both workers without an old stop" {
  run_lifecycle_test test_first_install_does_not_stop_nonexistent_systemd_units
  [ "$status" -eq 0 ]
}

@test "repeat upgrade stops old workers and restarts and verifies both new workers" {
  run_lifecycle_test \
    test_upgrade_stops_switches_starts_and_verifies_both_workers \
    test_install_runs_complete_transaction_with_fake_host_boundaries
  [ "$status" -eq 0 ]
}

@test "startup failure rolls back and verifies both previous workers" {
  run_lifecycle_test \
    test_startup_failure_restores_and_verifies_previous_release \
    test_install_activation_failure_restores_previous_release_transactionally
  [ "$status" -eq 0 ]
}

@test "rollback failure preserves new and previous release artifacts" {
  run_lifecycle_test test_rollback_failure_preserves_both_releases_and_reports_loudly
  [ "$status" -eq 0 ]
}

@test "systemd and Supervisor fake-command branches control both workers" {
  run_lifecycle_test \
    test_systemd_start_installs_both_units_and_uses_fake_commands \
    test_systemd_stop_failure_is_propagated \
    test_supervisor_start_uses_only_owned_state_and_fake_command \
    test_supervisor_start_polls_starting_until_both_workers_run \
    test_supervisor_start_rejects_fatal_worker_state \
    test_supervisor_stop_polls_workers_and_supervisord_to_termination
  [ "$status" -eq 0 ]
}

@test "custom root isolation and persisted controller transitions never probe fixed systemd units" {
  run_lifecycle_test \
    test_controller_selection_is_persisted_and_custom_root_never_probes_systemd \
    test_persisted_supervisor_transition_on_canonical_root_does_not_reprobe
  [ "$status" -eq 0 ]
}

@test "stale Supervisor socket and pid cleanup never deletes live owned state" {
  run_lifecycle_test \
    test_supervisor_stale_owned_socket_and_pid_are_cleaned \
    test_live_owned_supervisor_state_is_never_deleted
  [ "$status" -eq 0 ]
}

@test "preflight failures leave no managed filesystem mutation" {
  run_lifecycle_test \
    test_preflight_rejects_invalid_current_without_mutation \
    test_preflight_rejects_managed_log_directory_without_mutation \
    test_preflight_validates_existing_candidate_release_marker
  [ "$status" -eq 0 ]
}

@test "current and manual rollback targets require strict validated releases" {
  run_lifecycle_test \
    test_release_validation_is_exact_and_rejects_symlinks \
    test_current_target_must_be_exact_managed_release \
    test_rollback_command_and_runbook_use_validated_helper \
    test_manual_rollback_requires_published_release_contents_not_marker_alone
  [ "$status" -eq 0 ]
}

@test "bundle TOCTOU is rejected from the staged verification closure" {
  run_lifecycle_test \
    test_verified_staging_rejects_bundle_toctou \
    test_install_detects_bundle_mutation_between_initial_verify_and_staging
  [ "$status" -eq 0 ]
}

@test "lifecycle ownership and exclusive temp writes reject unsafe callers and paths" {
  run_lifecycle_test \
    test_lifecycle_entrypoints_reject_non_heqing_before_prepare_or_filesystem \
    test_foreign_owned_managed_path_is_rejected \
    test_controller_metadata_temp_file_is_exclusive \
    test_token_temp_file_is_exclusive \
    test_post_build_validation_failure_never_publishes_completion_marker
  [ "$status" -eq 0 ]
}

@test "Supervisor shutdown retries transient status failures and activation temp collisions are preserved" {
  run_lifecycle_test \
    test_supervisor_stop_retries_transient_status_failure_until_owned_state_disappears \
    test_activation_uses_exclusive_random_temp_and_preserves_collisions
  [ "$status" -eq 0 ]
}

@test "installer rejects traversal in the installation root" {
  make_bundle
  stub_install_preflight

  run "$REPO_ROOT/deploy/remote/install.sh" \
    --root "$BATS_TEST_TMPDIR/root/../escape" --bundle "$BUNDLE"

  [ "$status" -ne 0 ]
  [[ "$output" == *"unsupported or unsafe"* ]]
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
        "verificationStatus": "verified",
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
    manifest = {"verificationStatus": "verified", "model": model, "revision": revision}
    if directory == "Qwen3-Embedding-8B":
        manifest["dimensions"] = 4096
    if custom:
        paths.append("modeling_deepseekocr.py")
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
if [[ "\${1:-}" == info ]]; then
  printf '{"envs_dirs": ["$BATS_TEST_TMPDIR/conda/envs"], "pkgs_dirs": ["$BATS_TEST_TMPDIR/conda/pkgs"]}\n'
  exit 0
fi
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

run_lifecycle_test() {
  local tests=()
  local name
  for name in "$@"; do
    tests+=("deploy.remote.tests.test_deployment_lifecycle.DeploymentLifecycleTests.$name")
  done
  cd "$REPO_ROOT"
  run python3 -m unittest -v "${tests[@]}"
}
