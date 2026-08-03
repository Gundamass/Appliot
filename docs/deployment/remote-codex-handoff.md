# Remote Codex Handoff: GPU Worker Build and Deployment

This document is the execution contract for a Codex session running on the
remote A6000 server. It covers remote environment preflight, production asset
construction, installation, and acceptance for the embedding and OCR Workers.

The human operator must approve the preflight report before any environment,
model, or service is changed.

## Mission

Deploy both Workers as the unprivileged `heqing` user on Ubuntu 20.04 x86-64:

| Worker | Model | Pinned revision | Python | Remote listener |
| --- | --- | --- | --- | --- |
| Embedding | `Qwen/Qwen3-Embedding-8B` | `1d8ad4ca9b3dd8059ad90a75d4983776a23d44af` | 3.10 | `127.0.0.1:18080` |
| OCR | `deepseek-ai/DeepSeek-OCR-2` | `aaa02f3811945a91062062994c5c4a3f4c0af2b0` | 3.12 | `127.0.0.1:43121` |

Both processes must use physical GPU `5`. Because `CUDA_VISIBLE_DEVICES=5` is
set by the launchers, that device appears to each Worker as `cuda:0`.

The final installation root is `/home/heqing/resume-ai`. Build and download
work must remain under `/home/heqing/resume-ai-build`, and uploaded or checked
out deployment sources must remain under `/home/heqing/resume-ai-source` or
another explicitly approved path owned by `heqing`.

## Non-Negotiable Safety Rules

The remote Codex must obey all of the following:

1. Never use `sudo`, Docker, Podman, root shells, or system package changes.
2. Never change the NVIDIA driver, system CUDA, kernel, system Python, firewall,
   SSH configuration, or another user's files.
3. Never bind a Worker to `0.0.0.0`, a public address, or a non-pinned port.
4. Never print, log, paste, or commit service tokens, API keys, passwords, SSH
   private keys, raw resume content, or complete environment dumps.
5. Never guess a revision, dependency version, SHA-256, manifest entry, or
   custom-code approval. Hash the bytes actually present.
6. Never deploy checked-in template manifests or template OCR lock files.
7. Never weaken `deploy/remote/verify-assets.py` or the installer to make an
   invalid bundle pass.
8. Never mark DeepSeek OCR custom code as reviewed without reading every
   downloaded `.py` file and recording a concise security review.
9. Never delete an existing installation or release to fix a failed upgrade.
   Use the transactional installer and preserve rollback material.
10. Stop at every explicit human approval gate in this document.

Commands may write only beneath directories owned by `heqing`. Before any
recursive move or deletion, resolve and print the target path, confirm it is
beneath `/home/heqing/resume-ai-build` or an explicitly approved staging root,
and avoid following symlinks.

## Required Repository State

The repository containing this document must be available on the server before
Phase 1. The remote Codex must locate the repository root and confirm these
files exist:

```text
deploy/remote/verify-assets.py
deploy/remote/install.sh
deploy/remote/deployment.py
services/embedding-worker/pyproject.toml
services/ocr-worker/pyproject.toml
docs/deployment/remote-gpu.md
```

The large generated `bundle/`, model snapshots, wheelhouses, token files, and
`.env.local` must never be committed to Git.

## Phase 0: Read-Only Preflight

### Scope

This phase is strictly read-only. Do not create Conda environments, download
models, install packages, edit files, start services, or change permissions.

### Checks

Run the following without printing environment variables:

```bash
set -eu

printf '%s\n' '=== identity ==='
id
whoami

printf '%s\n' '=== operating system ==='
uname -m
sed -n '1,12p' /etc/os-release

printf '%s\n' '=== gpu inventory ==='
nvidia-smi --query-gpu=index,name,uuid,memory.total,memory.used \
  --format=csv,noheader

printf '%s\n' '=== conda ==='
command -v conda || true
conda --version || true
conda info --envs || true

printf '%s\n' '=== storage ==='
df -h /home/heqing

printf '%s\n' '=== user supervision ==='
systemctl --user is-system-running || true
loginctl show-user heqing -p Linger || true

printf '%s\n' '=== tools ==='
python3 --version || true
git --version || true
curl --version | head -n 1 || true
rsync --version | head -n 1 || true

printf '%s\n' '=== network probes ==='
curl -fsSIL --max-time 15 https://github.com/ | head -n 1 || true
curl -fsSIL --max-time 15 https://huggingface.co/ | head -n 1 || true
curl -fsSIL --max-time 15 https://pypi.org/simple/ | head -n 1 || true
```

If Conda exists, inspect only its path metadata:

```bash
conda info --json | python3 -c '
import json, sys
v = json.load(sys.stdin)
for key in ("root_prefix", "envs_dirs", "pkgs_dirs", "platform"):
    print(f"{key}={v.get(key)}")
'
```

### Acceptance

- `whoami` is exactly `heqing`.
- OS is Ubuntu 20.04 and architecture is `x86_64`.
- Physical GPU index `5` is visible.
- `/home/heqing` has at least 100 GiB free.
- Conda is executable by `heqing`, or a user-space Miniforge installation is
  possible under `/home/heqing`.
- GitHub, Hugging Face, and PyPI are reachable, or the report clearly identifies
  which source requires an offline transfer.

### Required Stop

Write a sanitized report to:

```text
/home/heqing/resume-ai-preflight.md
```

The report must contain pass/fail results, GPU inventory, free disk, Conda
paths, supervision availability, and network reachability. It must contain no
environment dump or secrets. Then stop and ask the human operator to approve
Phase 1.

## Phase 1: Prepare Isolated Build Environments

Begin only after explicit human approval of Phase 0.

Create private build directories:

```bash
umask 077
mkdir -p /home/heqing/resume-ai-build/{bundle,reports,downloads}
chmod 700 /home/heqing/resume-ai-build
```

Use the existing user-owned Conda installation when safe. If none exists,
install Miniforge only beneath `/home/heqing/miniforge3`; do not modify global
shell startup files without approval. Source its profile script for the current
session.

Create separate build environments:

```bash
conda create -y -n resume-embedding-build python=3.10 pip
conda create -y -n resume-ocr-build python=3.12 pip
```

The final installer invokes Conda with `--offline`. Therefore, before Phase 4,
the user Conda package cache must contain installable Python 3.10, Python 3.12,
and pip packages for the target `linux-64` platform. Prove this with:

```bash
conda search --offline --json 'python=3.10' >/dev/null
conda search --offline --json 'python=3.12' >/dev/null
```

Do not continue if either check fails.

## Phase 2: Download and Review Pinned Models

Install `huggingface_hub` in a disposable user environment and download exact
commits with symlinks disabled or materialized. Do not download `main` and then
claim it is the pinned revision.

Expected destinations:

```text
/home/heqing/resume-ai-build/bundle/models/Qwen3-Embedding-8B
/home/heqing/resume-ai-build/bundle/models/DeepSeek-OCR-2
```

Use the Hugging Face API with the exact revisions from the mission table.
After download:

1. Reject every symlink in either snapshot.
2. Record the resolved Hugging Face commit for each model.
3. Ensure all model weight shards referenced by index/config files exist.
4. Inventory every regular file and its SHA-256.
5. For DeepSeek OCR, read every `.py` file. Look for network calls, shell or
   subprocess execution, dynamic downloads, arbitrary file access, `eval`,
   `exec`, unsafe deserialization, and import-time side effects.

Write the OCR review to:

```text
/home/heqing/resume-ai-build/reports/deepseek-ocr-custom-code-review.md
```

The report should list reviewed relative paths, SHA-256 values, findings, and a
clear approve/block verdict. Do not paste complete source files into the report.
If any file is unclear or unsafe, stop and request human review. Only an
approved review permits `verificationStatus: verified`.

## Phase 3: Build Complete Offline Worker Assets

Create exactly this structure:

```text
bundle/
  conda-channel/
    linux-64/
      repodata.json
      current_repodata.json
      ...verified Conda packages...
    noarch/
      repodata.json
      current_repodata.json
      ...verified Conda packages...
  workers/
    embedding-worker/
      requirements.lock
      worker-manifest.json
      wheelhouse/
    ocr-worker/
      requirements.lock
      worker-manifest.json
      wheelhouse/
  models/
    Qwen3-Embedding-8B/
      model-manifest.json
      ...snapshot files...
    DeepSeek-OCR-2/
      model-manifest.json
      ...snapshot files and reviewed custom code...
```

Build both project wheels from the repository source. On Windows, `uv build`
avoids requiring a local Linux or WSL installation:

```powershell
uv build --wheel services/embedding-worker --out-dir C:\ApplyPilotBuild\project-wheels\embedding
uv build --wheel services/ocr-worker --out-dir C:\ApplyPilotBuild\project-wheels\ocr
```

Copy the produced wheels into their respective wheelhouses. Resolve and
download the complete Linux dependency closure for each Worker. The embedding
closure must include Supervisor because it is the fallback process controller.
For a cross-platform `pip download` from Windows, use the target Python ABI,
both `manylinux2014_x86_64` and `linux_x86_64` platform tags, and `--no-deps`.
The lock already contains the Linux dependency closure; `--no-deps` prevents
pip from re-evaluating Windows-only environment markers.

Requirements locks must satisfy all of these rules:

- begin with a standalone `--require-hashes` line;
- pin every package with `name==version`;
- attach at least one real `--hash=sha256:<64 lowercase hex>` value to every
  logical requirement;
- contain no index URL, trusted-host, editable, local path, VCS, unpinned, or
  placeholder entry;
- correspond exactly to files available in the matching wheelhouse;
- install with `--no-index --no-deps --require-hashes` in a fresh environment.

Do not infer lock hashes from package metadata. Hash the downloaded wheel bytes.
Do not accept source distributions unless their offline build dependencies are
also fully captured and the choice is explicitly reviewed.

Prove each bundle in a fresh temporary Conda prefix with network unavailable or
with pip forced to `--no-index`:

```bash
python -m pip install \
  --no-index \
  --no-deps \
  --require-hashes \
  --find-links /absolute/path/to/wheelhouse \
  -r /absolute/path/to/requirements.lock
```

Then install the project wheel with `--no-index --no-deps`, import its main
module, and confirm the exact Python minor version. Do this independently for
both Workers.

If dependency resolution cannot produce a complete, hash-locked Linux
wheelhouse, stop. Do not edit the verifier or installer around the failure.

## Phase 4: Generate Exact Manifests and Verify the Bundle

Generate manifests from the final bytes only. Any later file change invalidates
the manifest and requires regeneration.

Worker manifests must contain exactly:

```text
verificationStatus, worker, python, wheel, files
```

Expected identities:

```text
embedding worker: resume-embedding-worker, Python 3.10
ocr worker:       resume-ocr-worker, Python 3.12
```

Model manifests must contain exact pinned identities and revisions. Qwen also
contains `dimensions: 4096`. The OCR manifest contains `customCodeFiles`, which
must list every and only every verified `.py` file in the snapshot.

For every manifest:

- `files` covers every regular file below its directory exactly once;
- the manifest file itself is excluded;
- paths are relative POSIX paths;
- every SHA-256 is computed from the corresponding file;
- no symlink, duplicate, missing, unlisted, absolute, or traversal path exists.

Run from the repository root:

```bash
python3 deploy/remote/verify-assets.py \
  --bundle /home/heqing/resume-ai-build/bundle
```

Capture only the resulting bundle fingerprint in:

```text
/home/heqing/resume-ai-build/reports/bundle-fingerprint.txt
```

Run the verifier twice and require identical fingerprints. If verification
fails, fix the artifact, never the validation rule.

### Required Stop

Write a Phase 1-4 report containing model revisions, model sizes, wheel counts,
lock verification results, OCR review verdict, and bundle fingerprint. Do not
include tokens, source text, or model file contents. Stop for human approval
before installation.

## Phase 5: Transactional Installation

Begin only after explicit approval of the verified bundle report.

Record a non-secret baseline:

```bash
nvidia-smi --query-gpu=index,uuid,memory.used --format=csv,noheader \
  > /home/heqing/resume-ai-build/reports/gpu-before.csv
df -h /home/heqing \
  > /home/heqing/resume-ai-build/reports/disk-before.txt
```

Install using only the checked-in transactional installer:

```bash
cd /path/to/repository
bash deploy/remote/install.sh \
  --root /home/heqing/resume-ai \
  --bundle /home/heqing/resume-ai-build/bundle
```

Do not manually create or edit files beneath the installation root while the
installer runs. On failure, preserve all output and release directories, redact
secrets, and diagnose before retrying.

After success:

```bash
/home/heqing/resume-ai/services/bin/status.sh
ss -ltn | awk '$4 ~ /127\.0\.0\.1:(18080|43121)$/ {print}'
nvidia-smi --query-gpu=index,uuid,memory.used --format=csv,noheader \
  > /home/heqing/resume-ai-build/reports/gpu-after.csv
```

Acceptance requires:

- both Workers report running;
- only remote loopback listeners exist on ports 18080 and 43121;
- new project GPU memory is attributable only to physical GPU 5;
- GPUs `0-4,6,7` show no project-caused increase;
- token files exist at the documented paths with mode `0600`;
- `/readyz` returns the exact pinned identities when authenticated.

Never display token contents. It is acceptable to report token path, owner,
mode, byte length, and a one-way SHA-256 fingerprint only if needed for transfer
verification.

## Phase 6: Remote Functional Acceptance

Use local shell variables populated without echoing and call only loopback
addresses. Do not place tokens directly in saved shell history. Verify:

1. Embedding readiness reports the pinned Qwen model, revision, and 4096
   dimensions.
2. A small synthetic Chinese embedding request returns finite 4096-dimensional
   unit vectors.
3. OCR readiness reports the pinned DeepSeek OCR model and revision.
4. A synthetic, non-personal test image produces OCR text.
5. Service logs contain no request authorization header, token, raw resume, or
   complete OCR request body.
6. Stop/start/status commands preserve the same controller and recover both
   services.

The repository's complete cross-machine acceptance remains local because it
uses an SSH tunnel and checked-in fixtures:

```powershell
.\scripts\open-model-tunnel.ps1 -HostName REMOTE_HOST -User heqing
node --env-file=.env.local scripts/verify-remote-workers.mjs
```

The remote Codex must not request that tokens be pasted into chat. The human
operator should transfer token files through the authenticated SSH channel,
place values in the local uncommitted `.env.local`, and delete temporary copies.

## Failure Policy

On any failure:

1. Stop the current phase.
2. Record the exact failing command, exit code, and a sanitized error summary.
3. Do not repeatedly retry downloads or installations without identifying the
   cause.
4. Do not change pinned model identity, revision, dimensions, port, user,
   installation root, GPU index, or verification policy.
5. Ask the human operator before destructive cleanup, dependency substitution,
   or repository code changes.

Repository code changes are permitted only for a demonstrated defect that
blocks the documented deployment. Use tests first, commit code separately from
generated assets, and report the commit hash. Never commit model weights,
wheelhouses, generated manifests, tokens, or environment files.

## Sanitized Final Report

Write the final report to:

```text
/home/heqing/resume-ai-build/reports/final-acceptance.md
```

Include:

- OS, architecture, and effective user;
- physical GPU 5 identity and before/after memory summary;
- exact model identities and revisions;
- Python versions and Worker package versions;
- bundle fingerprint and active release ID;
- controller type and service status;
- bound listener addresses;
- offline install proof;
- custom-code review verdict;
- functional test pass/fail table;
- remaining blockers and manual follow-up commands.

Exclude all secrets, URLs containing credentials, raw request/response bodies,
resume content, private paths unrelated to this project, and complete logs.

## Initial Prompt for the Remote Codex

Give the remote Codex this prompt from the repository root:

```text
Read docs/deployment/remote-codex-handoff.md and
docs/deployment/remote-gpu.md completely before acting. Treat the handoff as
the execution contract. Start with Phase 0 only: perform the read-only
preflight, write /home/heqing/resume-ai-preflight.md, summarize sanitized
pass/fail results, and stop for my approval. Do not create environments,
download models, install packages, start services, use sudo or Docker, modify
system configuration, expose ports, or print secrets. If repository
instructions conflict with the handoff, stop and explain the conflict rather
than choosing silently.
```

After reviewing `/home/heqing/resume-ai-preflight.md`, the human operator may
authorize the next phase explicitly. Do not grant blanket approval for all
remaining phases; retain the approval gate before installation.
