# Remote GPU Worker Deployment

This runbook installs the embedding and OCR Workers as `heqing` under
`/home/heqing/resume-ai` on Ubuntu 20.04 x86-64. It does not require or permit
`sudo`, Docker, a system Python change, a driver change, a system CUDA change,
or a public Worker listener. Physical GPU 5 is exposed to each process as
`cuda:0`.

## Acceptance Blockers

Do not deploy the checked-in model manifests or OCR requirements lock. They are
deliberately non-deployable templates. Deployment remains blocked until all of
these artifacts have been produced and reviewed on a Linux x86-64 environment:

- a complete Qwen snapshot for revision
  `1d8ad4ca9b3dd8059ad90a75d4983776a23d44af` and a verified manifest covering every file;
- a complete DeepSeek OCR snapshot for revision
  `aaa02f3811945a91062062994c5c4a3f4c0af2b0`, including reviewed custom Python
  files and a `verificationStatus` of `verified`;
- Linux wheelhouses containing every locked dependency and each built Worker
  wheel, with both Worker manifests marked `verificationStatus: verified`;
- fully pinned `requirements.lock` files in pip `--require-hashes` format. The
  embedding lock must also install Supervisor for the non-systemd fallback.

Never guess, copy from a different snapshot, or use a placeholder SHA-256.

## Bundle Layout

Prepare this tree under WSL or another Linux x86-64 environment:

```text
bundle/
  workers/
    embedding-worker/
      requirements.lock
      worker-manifest.json
      wheelhouse/
        resume_embedding_worker-<version>-py3-none-any.whl
        ...all locked Linux wheels...
    ocr-worker/
      requirements.lock
      worker-manifest.json
      wheelhouse/
        resume_ocr_worker-<version>-py3-none-any.whl
        ...all locked Linux wheels...
  models/
    Qwen3-Embedding-8B/
      model-manifest.json
      ...complete snapshot...
    DeepSeek-OCR-2/
      model-manifest.json
      ...complete snapshot and reviewed custom code...
```

Each `worker-manifest.json` contains `worker`, `python`, `wheel`, and `files`.
The embedding values are `resume-embedding-worker` and `3.10`; the OCR values
are `resume-ocr-worker` and `3.12`. `wheel` is the relative path of that
Worker's wheel. `files` must contain every other regular file below the Worker
directory exactly once, with a relative POSIX `path` and the SHA-256 computed
from that exact file. The manifest itself is excluded from `files`.

Each model manifest must likewise cover every snapshot file except the manifest
itself. Qwen also pins `dimensions` to `4096`. DeepSeek must list every `.py`
file exactly once in `customCodeFiles`. Symlinks, duplicate paths, traversal,
unlisted files, missing files, wrong identities, wrong revisions, and hash
mismatches are rejected.

Build the Worker wheels and generate both locks on the target-compatible Linux
platform. Download dependencies into each `wheelhouse/` from a networked build
machine, then disconnect or block network access and prove the lock installs
with `--no-index --no-deps --require-hashes`. Compute manifests only after the
bundle is final.

From the repository root, verify before upload:

```bash
python3 deploy/remote/verify-assets.py --bundle /absolute/path/to/bundle
```

The command prints one bundle fingerprint, not file contents or secrets.

## Upload And Verify

Use a private staging directory, not the installation root:

```bash
ssh heqing@REMOTE_HOST 'umask 077; mkdir -p /home/heqing/resume-ai-upload/task4'
rsync -avP --protect-args deploy/remote/ \
  heqing@REMOTE_HOST:/home/heqing/resume-ai-upload/task4/deploy/remote/
rsync -avP --protect-args /absolute/path/to/bundle/ \
  heqing@REMOTE_HOST:/home/heqing/resume-ai-upload/task4/bundle/
```

On the remote host, verify the uploaded bytes again:

```bash
cd /home/heqing/resume-ai-upload/task4
python3 deploy/remote/verify-assets.py --bundle "$PWD/bundle"
```

The local and remote fingerprints must match. Stop if either command fails.

## Install

Confirm that GPU index 5 is visible and that the target filesystem has at least
100 GiB free. The installer checks these again, checks Ubuntu x86-64 and both
offline Conda Python versions, and verifies every asset before creating or
changing an environment.

```bash
nvidia-smi --query-gpu=index,name --format=csv
df -h /home/heqing
cd /home/heqing/resume-ai-upload/task4
bash deploy/remote/install.sh \
  --root /home/heqing/resume-ai \
  --bundle "$PWD/bundle"
```

Installation verifies the uploaded bundle before host preflight or Conda search,
then takes an install lock and copies it to a private staging snapshot. The
snapshot is verified again and is the only source used for Conda and model
installation. All managed paths, destination parents, controller metadata,
runtime paths, and effective Conda env/package/cache directories are inspected
before the first directory, permission, token, or environment mutation.

Both Conda environments and model snapshots complete in an inactive
content-addressed release before activation. During an upgrade the persisted
controller stops both old Workers, changes the single `current` link atomically,
starts both new Workers, and verifies both `/readyz` responses and pinned model
identities. A failed startup stops partial new processes, strictly validates the
previous release, restores it, and starts and verifies both old Workers. If that
rollback fails, the installer reports `ROLLBACK FAILED` and preserves every
release artifact for recovery; it never removes files that may back a running
process.

The installer creates the token files with umask `077`, sets mode `0600`, and
prints only these paths:

```text
/home/heqing/resume-ai/run/embedding.token
/home/heqing/resume-ai/run/ocr.token
```

Never print either token with `cat`, place it in a command argument, or paste it
into a ticket, chat, or log. Transfer the files over the existing SSH channel to
a private local temporary directory, use a local editor to place the values in
the uncommitted `.env.local`, then remove the temporary copies. The local names
are:

```dotenv
EMBEDDING_BASE_URL=http://127.0.0.1:18080
EMBEDDING_API_TOKEN=<value from embedding.token>
OCR_BASE_URL=http://127.0.0.1:43121
OCR_API_TOKEN=<value from ocr.token>
```

Do not commit `.env.local`.

## Supervision

The installer persists root and controller ownership metadata. User systemd is
eligible only for the canonical `/home/heqing/resume-ai` root when
`systemctl --user` is usable and `loginctl` reports linger enabled. Custom roots
always use Supervisor and never inspect or stop the fixed systemd units. Every
start, stop, status, upgrade, and rollback uses the same persisted controller.
Systemd failures are returned as failures. Supervisor accepts only its owned
pid/socket/config state and cleans stale owned state before launch. No secret
appears in a unit, Supervisor command, process argument, or service log
configuration.

```bash
/home/heqing/resume-ai/services/bin/start-all.sh
/home/heqing/resume-ai/services/bin/status.sh
/home/heqing/resume-ai/services/bin/stop-all.sh
```

Supervisor rotates each stdout/stderr log at 20 MiB and retains five backups.
Inspect status first, then only the necessary log tail:

```bash
tail -n 100 /home/heqing/resume-ai/logs/embedding.stderr.log
tail -n 100 /home/heqing/resume-ai/logs/ocr.stderr.log
```

Do not add cron entries or system services. When user systemd or linger is not
available, run `start-all.sh` after each login or reboot. Persistence beyond
that requires explicit administrator approval.

## SSH Tunnel

Both Workers listen only on remote loopback. From the local Windows machine,
use the checked-in helper or equivalent OpenSSH command:

```powershell
.\scripts\open-model-tunnel.ps1 -HostName REMOTE_HOST -User heqing
```

Equivalent forwarding is:

```bash
ssh -N \
  -L 18080:127.0.0.1:18080 \
  -L 43121:127.0.0.1:43121 \
  heqing@REMOTE_HOST
```

Never change either Worker bind address to `0.0.0.0` and do not open these ports
in a firewall or security group.

## Revision Upgrade And Rollback

For an upgrade, prepare new complete snapshots, locks, wheelhouses, and manifests
under a new staging bundle. Keep the pinned identity/revision constants in the
Worker code, deployment verifier, launcher, and manifest aligned. Verify locally,
upload, verify remotely, then rerun `install.sh`. It creates a distinct release
and preserves older complete releases.

To inspect releases without exposing secrets:

```bash
readlink /home/heqing/resume-ai/current
find /home/heqing/resume-ai/releases -mindepth 1 -maxdepth 1 -type d -printf '%f\n'
```

The installer automatically restores and verifies the previous release when a
new release fails startup. For an operator-directed rollback, use the checked-in
transactional command. It accepts only a lowercase 64-hex release ID whose
direct, non-symlink release directory has a regular `.complete` file exactly
matching that ID. It stops both Workers, activates once, restarts both, and
verifies their identities; on failure it applies the same safe rollback rules as
installation:

```bash
release_id=REVIEWED_64_HEX_RELEASE_ID
/home/heqing/resume-ai/services/bin/rollback.sh --release "$release_id"
```

For disk cleanup, retain the active release and at least one known-good rollback
release. Stop services before deleting an inactive release. Resolve and compare
the active target first, and remove only an exact 64-hex directory directly
under `/home/heqing/resume-ai/releases`. Never remove `current`, token files,
logs needed for an incident, or an unverified path.
