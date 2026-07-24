#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="/home/heqing/resume-ai"
BUNDLE=""
PYTHON_BIN="${PYTHON_BIN:-python3}"
CONDA_BIN="${CONDA_EXE:-conda}"
MIN_FREE_KIB=$((100 * 1024 * 1024))
LOCK_DIRECTORY=""
NEW_RELEASE=""
OLD_CURRENT=""
ACTIVATED=0

usage() {
  printf 'Usage: %s [--root PATH] --bundle PATH\n' "$0" >&2
}

die() {
  printf 'install: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  local status
  status=$1
  if (( status != 0 && ACTIVATED == 1 )); then
    restore_current
  fi
  if (( status != 0 )) && [[ -n "$NEW_RELEASE" && -d "$NEW_RELEASE" ]]; then
    safe_remove_release "$NEW_RELEASE"
  fi
  if [[ -n "$LOCK_DIRECTORY" && -d "$LOCK_DIRECTORY" ]]; then
    rmdir -- "$LOCK_DIRECTORY" 2>/dev/null || true
  fi
  trap - EXIT
  exit "$status"
}

main() {
  trap 'cleanup $?' EXIT
  while (( $# > 0 )); do
    case "$1" in
      --root)
        (( $# >= 2 )) || die "--root requires a path"
        ROOT=$2
        shift 2
        ;;
      --bundle)
        (( $# >= 2 )) || die "--bundle requires a path"
        BUNDLE=$2
        shift 2
        ;;
      --help|-h)
        usage
        return 0
        ;;
      *)
        usage
        die "unknown argument: $1"
        ;;
    esac
  done

  [[ -n "$BUNDLE" ]] || { usage; die "--bundle is required"; }
  [[ "$ROOT" == /* && "$ROOT" != / ]] \
    || die "installation root must be an absolute non-root path"
  case "$ROOT" in
    */../*|*/..|*/./*|*/.) die "installation root must not contain traversal" ;;
  esac
  [[ "$BUNDLE" == /* ]] || BUNDLE="$(pwd -P)/$BUNDLE"

  preflight
  BUNDLE_FINGERPRINT="$("$PYTHON_BIN" "$SCRIPT_DIR/verify-assets.py" --bundle "$BUNDLE")"
  [[ "$BUNDLE_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]] \
    || die "asset verifier returned an invalid fingerprint"
  DEPLOYMENT_FINGERPRINT="$(deployment_fingerprint "$BUNDLE_FINGERPRINT")"

  create_stable_directories
  LOCK_DIRECTORY="$ROOT/run/install.lock"
  mkdir -- "$LOCK_DIRECTORY" 2>/dev/null || die "another installation is already running"

  RELEASE="$ROOT/releases/$DEPLOYMENT_FINGERPRINT"
  [[ ! -L "$RELEASE" ]] || die "release path must not be a symbolic link"
  if [[ -e "$RELEASE" && ! -f "$RELEASE/.complete" ]]; then
    safe_remove_release "$RELEASE"
  fi
  if [[ ! -f "$RELEASE/.complete" ]]; then
    NEW_RELEASE=$RELEASE
    build_release "$RELEASE"
  fi
  validate_release "$RELEASE"

  ensure_runtime_links
  generate_token "$ROOT/run/embedding.token" "$RELEASE/envs/embedding/bin/python"
  generate_token "$ROOT/run/ocr.token" "$RELEASE/envs/ocr/bin/python"

  if [[ -L "$ROOT/current" ]]; then
    OLD_CURRENT="$(readlink -- "$ROOT/current")"
  elif [[ -e "$ROOT/current" ]]; then
    die "$ROOT/current must be a managed symbolic link"
  fi
  activate_release "$DEPLOYMENT_FINGERPRINT"
  ACTIVATED=1

  if ! RESUME_AI_ROOT="$ROOT" "$ROOT/services/bin/start-all.sh"; then
    die "services failed to start; restored the previous release"
  fi

  ACTIVATED=0
  NEW_RELEASE=""
  printf 'Installation active at %s\n' "$ROOT/current"
  printf 'Embedding token file: %s\n' "$ROOT/run/embedding.token"
  printf 'OCR token file: %s\n' "$ROOT/run/ocr.token"
}

preflight() {
  local os_release os_id os_version writable_parent available_kib
  [[ "$(uname -s)" == Linux ]] || die "Ubuntu Linux is required"
  [[ "$(uname -m)" == x86_64 ]] || die "x86-64 is required"
  [[ "$(id -un)" == heqing ]] || die "installer must run as user heqing"

  os_release="${RESUME_AI_OS_RELEASE:-/etc/os-release}"
  [[ -f "$os_release" && ! -L "$os_release" ]] || die "Ubuntu release metadata is unavailable"
  os_id="$(awk -F= '$1 == "ID" {gsub(/"/, "", $2); print $2}' "$os_release")"
  os_version="$(awk -F= '$1 == "VERSION_ID" {gsub(/"/, "", $2); print $2}' "$os_release")"
  [[ "$os_id" == ubuntu && "$os_version" == 20.04 ]] || die "Ubuntu 20.04 is required"

  command -v "$PYTHON_BIN" >/dev/null 2>&1 || die "python3 is required for verification"
  command -v "$CONDA_BIN" >/dev/null 2>&1 || die "Conda is required in user space"
  command -v nvidia-smi >/dev/null 2>&1 || die "nvidia-smi is required"
  nvidia-smi --query-gpu=index --format=csv,noheader,nounits 2>/dev/null \
    | tr -d '[:blank:]' \
    | grep -Fxq 5 \
    || die "physical GPU 5 is not visible"

  writable_parent="$(nearest_existing_parent "$ROOT")"
  [[ -d "$writable_parent" && -w "$writable_parent" && ! -L "$writable_parent" ]] \
    || die "installation filesystem is not writable"
  if [[ -e "$ROOT" ]]; then
    [[ -d "$ROOT" && -w "$ROOT" && ! -L "$ROOT" ]] || die "installation root is unsafe or not writable"
  fi
  available_kib="$(df -Pk -- "$writable_parent" | awk 'NR == 2 {print $4}')"
  [[ "$available_kib" =~ ^[0-9]+$ ]] || die "could not determine free disk space"
  (( available_kib >= MIN_FREE_KIB )) || die "at least 100 GiB free is required"

  verify_conda_python 3.10
  verify_conda_python 3.12
}

verify_conda_python() {
  local version search_result
  version=$1
  search_result="$("$CONDA_BIN" search --offline --json "python=$version")" \
    || die "Conda has no offline Python $version package"
  printf '%s' "$search_result" | "$PYTHON_BIN" -c \
    'import json, sys; value=json.load(sys.stdin); raise SystemExit(0 if any(value.values()) else 1)' \
    || die "Conda has no offline Python $version package"
}

nearest_existing_parent() {
  local candidate parent
  candidate=$1
  while [[ ! -e "$candidate" ]]; do
    parent="$(dirname -- "$candidate")"
    [[ "$parent" != "$candidate" ]] || die "could not find target filesystem"
    candidate=$parent
  done
  printf '%s\n' "$candidate"
}

deployment_fingerprint() {
  local bundle_fingerprint
  bundle_fingerprint=$1
  "$PYTHON_BIN" - "$SCRIPT_DIR" "$bundle_fingerprint" <<'PY'
import hashlib
import sys
from pathlib import Path

root = Path(sys.argv[1])
digest = hashlib.sha256(sys.argv[2].encode("ascii"))
paths = [
    root / "env.example",
    root / "supervisord.conf",
    *sorted((root / "bin").glob("*.sh")),
    *sorted((root / "systemd").glob("*.service")),
]
for path in paths:
    digest.update(path.relative_to(root).as_posix().encode("utf-8"))
    digest.update(path.read_bytes())
print(digest.hexdigest())
PY
}

create_stable_directories() {
  local path
  umask 077
  mkdir -p -- "$ROOT"
  for path in "$ROOT/releases" "$ROOT/envs" "$ROOT/models" "$ROOT/cache" \
    "$ROOT/logs" "$ROOT/run" "$ROOT/tmp"; do
    [[ ! -L "$path" && ( ! -e "$path" || -d "$path" ) ]] \
      || die "unsafe managed directory: $path"
  done
  mkdir -p -- "$ROOT/releases" "$ROOT/envs" "$ROOT/models" \
    "$ROOT/cache" "$ROOT/logs" "$ROOT/run" "$ROOT/tmp"
  chmod 700 -- "$ROOT/cache" "$ROOT/logs" "$ROOT/run" "$ROOT/tmp"
}

build_release() {
  local release
  release=$1
  umask 077
  mkdir -p -- "$release/envs" "$release/models/Qwen3-Embedding-8B" \
    "$release/models/DeepSeek-OCR-2" "$release/services/bin" "$release/services/systemd"

  create_environment embedding 3.10 embedding-worker resume_embedding_worker.main "$release"
  create_environment ocr 3.12 ocr-worker resume_ocr_worker.main "$release"
  [[ -x "$release/envs/embedding/bin/supervisord" ]] \
    || die "embedding lock must install Supervisor for the fallback launcher"

  cp -a -- "$BUNDLE/models/Qwen3-Embedding-8B/." "$release/models/Qwen3-Embedding-8B/"
  cp -a -- "$BUNDLE/models/DeepSeek-OCR-2/." "$release/models/DeepSeek-OCR-2/"
  cp -a -- "$SCRIPT_DIR/bin/." "$release/services/bin/"
  cp -a -- "$SCRIPT_DIR/systemd/." "$release/services/systemd/"
  cp -- "$SCRIPT_DIR/supervisord.conf" "$SCRIPT_DIR/env.example" "$release/services/"
  chmod 700 -- "$release/services/bin/"*.sh
  chmod 600 -- "$release/services/systemd/"*.service "$release/services/supervisord.conf" \
    "$release/services/env.example"
  printf '%s\n' "$DEPLOYMENT_FINGERPRINT" > "$release/.complete"
  chmod 600 -- "$release/.complete"
}

validate_release() {
  local release name python_version module path
  release=$1
  [[ -d "$release" && ! -L "$release" ]] || die "release directory is unsafe"
  [[ -f "$release/.complete" && ! -L "$release/.complete" ]] \
    || die "release completion marker is unsafe"
  [[ "$(cat -- "$release/.complete")" == "$DEPLOYMENT_FINGERPRINT" ]] \
    || die "release completion marker does not match"

  for path in "$release/envs/embedding" "$release/envs/ocr" \
    "$release/models/Qwen3-Embedding-8B" "$release/models/DeepSeek-OCR-2" \
    "$release/services"; do
    [[ -d "$path" && ! -L "$path" ]] || die "release contains an unsafe managed directory"
  done
  diff -qr --no-dereference "$BUNDLE/models/Qwen3-Embedding-8B" \
    "$release/models/Qwen3-Embedding-8B" >/dev/null \
    || die "installed Qwen model does not match the verified bundle"
  diff -qr --no-dereference "$BUNDLE/models/DeepSeek-OCR-2" \
    "$release/models/DeepSeek-OCR-2" >/dev/null \
    || die "installed DeepSeek model does not match the verified bundle"

  for path in bin systemd; do
    diff -qr --no-dereference "$SCRIPT_DIR/$path" "$release/services/$path" >/dev/null \
      || die "installed service $path does not match deployment assets"
  done
  for path in supervisord.conf env.example; do
    cmp -s -- "$SCRIPT_DIR/$path" "$release/services/$path" \
      || die "installed service file $path does not match deployment assets"
  done

  for name in embedding ocr; do
    if [[ "$name" == embedding ]]; then
      python_version=3.10
      module=resume_embedding_worker.main
    else
      python_version=3.12
      module=resume_ocr_worker.main
    fi
    "$release/envs/$name/bin/python" -c \
      "import sys; assert sys.version_info[:2] == tuple(map(int, '$python_version'.split('.'))); import $module" \
      || die "$name environment validation failed"
  done
  [[ -x "$release/envs/embedding/bin/supervisord" ]] \
    || die "Supervisor is missing from the embedding environment"
}

create_environment() {
  local name python_version worker_directory import_module release prefix worker_root wheel_relative
  name=$1
  python_version=$2
  worker_directory=$3
  import_module=$4
  release=$5
  prefix="$release/envs/$name"
  worker_root="$BUNDLE/workers/$worker_directory"
  wheel_relative="$("$PYTHON_BIN" - "$worker_root/worker-manifest.json" <<'PY'
import json
import sys
from pathlib import Path
print(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["wheel"])
PY
)"

  "$CONDA_BIN" create --yes --offline --prefix "$prefix" "python=$python_version" pip
  "$CONDA_BIN" run --no-capture-output --prefix "$prefix" \
    python -m pip install --disable-pip-version-check --no-index --no-deps \
    --require-hashes --find-links "$worker_root/wheelhouse" -r "$worker_root/requirements.lock"
  "$CONDA_BIN" run --no-capture-output --prefix "$prefix" \
    python -m pip install --disable-pip-version-check --no-index --no-deps \
    "$worker_root/$wheel_relative"
  "$CONDA_BIN" run --no-capture-output --prefix "$prefix" python -c \
    "import sys; assert sys.version_info[:2] == tuple(map(int, '$python_version'.split('.'))); import $import_module"
}

ensure_runtime_links() {
  ensure_managed_link "$ROOT/envs/embedding" ../current/envs/embedding
  ensure_managed_link "$ROOT/envs/ocr" ../current/envs/ocr
  ensure_managed_link "$ROOT/models/Qwen3-Embedding-8B" ../current/models/Qwen3-Embedding-8B
  ensure_managed_link "$ROOT/models/DeepSeek-OCR-2" ../current/models/DeepSeek-OCR-2
  ensure_managed_link "$ROOT/services" current/services
}

ensure_managed_link() {
  local link_path target temporary
  link_path=$1
  target=$2
  if [[ -L "$link_path" ]]; then
    [[ "$(readlink -- "$link_path")" == "$target" ]] \
      || die "$link_path is not an installer-managed link"
    return
  fi
  [[ ! -e "$link_path" ]] || die "$link_path exists and is not a symbolic link"
  temporary="$link_path.tmp.$$"
  ln -s -- "$target" "$temporary"
  mv -T -- "$temporary" "$link_path"
}

generate_token() {
  local token_path python temporary
  token_path=$1
  python=$2
  if [[ -L "$token_path" ]]; then
    die "$token_path must not be a symbolic link"
  fi
  if [[ -f "$token_path" ]]; then
    [[ -s "$token_path" ]] || die "$token_path is empty"
    chmod 600 -- "$token_path"
    validate_token "$token_path" "$python"
    return
  fi
  [[ ! -e "$token_path" ]] || die "$token_path is not a regular file"
  temporary="$token_path.tmp.$$"
  umask 077
  "$python" - <<'PY' > "$temporary"
import secrets
print(secrets.token_urlsafe(48))
PY
  chmod 600 -- "$temporary"
  mv -T -- "$temporary" "$token_path"
  validate_token "$token_path" "$python"
}

validate_token() {
  local token_path python
  token_path=$1
  python=$2
  "$python" - "$token_path" <<'PY' || die "$token_path does not contain one valid service token"
import re
import sys
from pathlib import Path

value = Path(sys.argv[1]).read_bytes()
raise SystemExit(0 if re.fullmatch(rb"[A-Za-z0-9_-]{64}\n", value) else 1)
PY
}

activate_release() {
  local release_id temporary
  release_id=$1
  temporary="$ROOT/.current.$$"
  ln -s -- "releases/$release_id" "$temporary"
  mv -Tf -- "$temporary" "$ROOT/current"
}

restore_current() {
  local temporary
  if [[ -n "$OLD_CURRENT" ]]; then
    temporary="$ROOT/.current.restore.$$"
    ln -s -- "$OLD_CURRENT" "$temporary"
    mv -Tf -- "$temporary" "$ROOT/current"
  else
    rm -f -- "$ROOT/current"
  fi
  ACTIVATED=0
}

safe_remove_release() {
  local candidate release_name release_parent
  candidate=$1
  release_name="$(basename -- "$candidate")"
  release_parent="$(dirname -- "$candidate")"
  [[ "$release_parent" == "$ROOT/releases" && "$release_name" =~ ^[0-9a-f]{64}$ ]] \
    || die "refusing to remove unsafe release path: $candidate"
  rm -rf -- "$candidate"
}

main "$@"
