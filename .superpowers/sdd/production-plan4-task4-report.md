# Plan 4 Task 4 Report

## Result

Implemented hash-verified, no-root remote deployment for both GPU Workers under
`/home/heqing/resume-ai`, with content-addressed inactive releases, atomic model
activation, generated mode-0600 service tokens, loopback-only launchers pinned
to physical GPU 5, and user-systemd/Supervisor control scripts.

## Verification

- Python verifier tests run locally on Windows: 10 passed, 1 skipped. The skipped
  test creates a symlink and requires Windows privileges not available here; the
  equivalent Bats/Linux path remains present for external execution.
- All deployment shell scripts pass `bash -n` under Git for Windows.
- A temporary local Bash harness exercised five Bats-equivalent paths: checksum
  rejection before Conda mutation, root traversal rejection, static GPU/device/
  loopback pins, mode-0600 token rejection without value leakage, and Supervisor
  fallback without tokens in argv. All five passed.
- `git diff --check` passes for task files.
- Bats and ShellCheck are not installed locally. No Ubuntu WSL distribution is
  available (`docker-desktop` is the only registered, stopped WSL instance).
  A temporary Bats download was attempted outside the repository, but GitHub
  reset the network connection. Run the exact acceptance command on WSL/Linux:
  `bats deploy/remote/tests/deploy.bats && shellcheck deploy/remote/*.sh deploy/remote/bin/*.sh`.

## External Blockers

1. The complete Qwen model snapshot and non-empty SHA-256 manifest remain
   external. The checked-in template has no model files and cannot deploy.
2. The complete DeepSeek-OCR-2 snapshot, reviewed custom-code inventory, and
   verified SHA-256 manifest remain external. The checked-in template is marked
   `template_unverified` and cannot deploy.
3. A target-compatible Linux x86-64 OCR hash lock remains external. The checked-in
   OCR lock is explicitly an unhashed acceptance-blocker template.
4. Complete Linux wheelhouses and Worker manifests covering every lock/wheelhouse
   file remain external. The embedding deployment lock must include Supervisor
   for the fallback path.
5. End-to-end Conda installation, GPU startup, user-systemd linger behavior, and
   Supervisor startup require the remote Ubuntu 20.04.6 host and real offline
   assets. The scripts fail before environment creation while blockers remain.

No hashes, model payloads, service tokens, or remote acceptance results were
invented.

## Phase A Replacement Fixer Evidence

Commit: `c7379f5 fix: close remote deployment bundle verification`

- Scope: asset verifier, focused Python tests, valid-bundle Bats fixture, and
  runbook manifest-status requirements only. Installer and controller logic was
  not changed.
- RED: `python -m unittest deploy.remote.tests.test_verify_assets -v` failed
  three regressions as intended: duplicate top-level JSON fields, duplicate
  nested JSON fields, and Windows-drive absolute manifest paths were accepted
  or rejected too late.
- GREEN: the same focused command passed 29 tests with 3 symlink tests skipped
  on Windows. Those tests execute on Linux, where symlink creation is available.
- `git diff --check -- deploy/remote/verify-assets.py
  deploy/remote/tests/test_verify_assets.py deploy/remote/tests/deploy.bats
  docs/deployment/remote-gpu.md` passed.
- The verifier now requires the exact top/intermediate hierarchy and exact
  manifested leaf closure, rejects extra files/directories, duplicate JSON and
  manifest paths, traversal, POSIX/Windows absolute paths, non-regular entries,
  and symlinks, and fingerprints every accepted directory and file byte digest
  in deterministic path order.
- All Qwen, OCR, embedding Worker, and OCR Worker manifests require the exact
  status `verified`. Exact model IDs/revisions, embedding dimensions, Worker
  identities/Python versions, requirements-lock coverage/hash checks, and
  verified wheelhouse wheel selection remain enforced.
- `verify_bundle()` and the verifier CLI remain standalone read-only entrypoints,
  so Phase B can invoke verification before installer mutation.

### Explicit Phase B Remainder

1. `install.sh` still runs `preflight`, including external `conda search`
   commands, before invoking the asset verifier. Phase B must move trust
   verification ahead of any installer or external-tool mutation.
2. `install.sh` verifies the live bundle once and later installs/copies from the
   same mutable paths. Phase B must bind consumption to the verified snapshot or
   revalidate immediately around consumption to close that installer TOCTOU.
3. `stop-all.sh` and `status.sh` do not use the same default-root and linger gate
   as `start-all.sh`; with a custom root they can stop or report unrelated user
   systemd units. Phase B must unify controller backend selection.
4. `stop-all.sh` suppresses systemd stop failures and reports `Worker stop
   requested` merely because user systemd was reachable. Phase B must report
   actual controller outcomes and preserve failures.

## Phase B Transactional Lifecycle Evidence

Commit message: `fix: make remote deployment transactional`

- RED: the new deterministic lifecycle suite initially failed 17 expectations
  because there was no shared transaction helper, strict rollback command,
  persisted controller ownership, staged bundle closure, or systemd working
  directory. Focused follow-up RED runs also proved first-install stop behavior,
  residue-free locking, all-release preflight, existing-release byte validation,
  live Supervisor socket preservation, and exact two-worker Supervisor status.
- Asset verification is now the first substantive installer validation. The
  installer then acquires a parent-scoped OS install lock, completes host/Conda
  and managed-path preflight without mutation, copies the bundle to private
  staging, reverifies the copied closure against the original digest, and uses
  only that snapshot for Conda and model installation.
- Preflight covers the root and destination parent, every managed directory,
  every existing release and completion marker, `current`, runtime links,
  controller metadata, tokens, known logs and Supervisor pid/socket entries,
  systemd unit destinations, and effective Conda env/package/cache paths.
- Releases are built outside `releases/` and published atomically only after the
  exact lowercase 64-hex `.complete` marker exists. Reused releases have models,
  service assets, Python versions/imports, and Supervisor revalidated against
  the verified snapshot and current deployment assets.
- Upgrade uses one persisted controller to stop both old Workers, atomically
  activate one release, start both new Workers, confirm controller state, and
  verify both authenticated `/readyz` model identities. Startup failure stops
  partial new processes, strictly restores and verifies the previous release,
  and preserves all artifacts with a loud `ROLLBACK FAILED` result if recovery
  cannot complete.
- `rollback.sh --release <lowercase-64-hex>` uses the same lock, strict release
  helper, controller, readiness checks, and failure recovery. The runbook no
  longer instructs operators to manipulate `current` manually.
- Root/controller ownership metadata pins all later start/stop/status/upgrade/
  rollback operations to one backend. Systemd is limited to
  `/home/heqing/resume-ai`, propagates stop failures, and both units now set
  `WorkingDirectory`. Custom roots use only owned Supervisor pid/socket/config
  state, clean stale state, preserve live state, and never probe fixed systemd
  units. Unsupported roots containing whitespace, `%`, controls, leading-option
  components, traversal, or unsupported characters are rejected before root
  mutation.
- `deploy.bats` now names deterministic first install, repeat upgrade, startup
  rollback, rollback-failure preservation, systemd/Supervisor, custom-root
  isolation, stale state/controller transitions, no-mutation preflight, invalid
  release/current, and bundle TOCTOU acceptance cases.

### Fresh Local Verification

- `python -m unittest deploy.remote.tests.test_verify_assets
  deploy.remote.tests.test_deployment_lifecycle -v`: 58 passed, 6 skipped. The
  skips require Windows symlink privilege or native Unix socket semantics and
  remain enabled on Linux.
- `python -m py_compile` passed for both deployment modules and both focused test
  modules.
- Python 3.8 AST parsing passed for `deployment.py`; Phase A already records the
  same gate for `verify-assets.py`.
- Git for Windows Bash accepted all seven deployment shell scripts with
  `bash -n`.
- `git diff --check -- deploy/remote docs/deployment/remote-gpu.md
  .superpowers/sdd/production-plan4-task4-report.md` passed.

### External-Only Remainder

1. Bats and ShellCheck are not installed locally; their target Linux commands
   remain pending without waiting for network installation.
2. Native Linux symlink/socket acceptance, Ubuntu 20.04 filesystem semantics,
   user-systemd linger, and real Supervisor process ownership remain pending on
   the target-compatible host.
3. Complete reviewed model manifests/snapshots, Linux hash locks, Linux
   wheelhouses (including Supervisor), and end-to-end offline Conda/GPU startup
   remain the external artifact and host acceptance blockers already listed
   above.

## Phase B Follow-up Review Evidence

Commit message: `fix: complete remote deployment transactions`

- RED/GREEN: focused lifecycle tests first failed for missing Supervisor bounded
  polling, activation-error recovery, pre-marker publication validation, caller
  and ownership gates, and exclusive metadata/token temporary writes. The final
  deterministic suite covers delayed `STARTING` to `RUNNING`, `FATAL` startup,
  delayed shutdown through worker exit and Supervisor pid cleanup, activation
  failure recovery, and loud artifact-preserving rollback failure behavior.
- Supervisor startup now polls the exact two owned programs until both are
  `RUNNING`, with the configured `startsecs` as a lower deadline bound and a
  positive configurable timeout. `BACKOFF`, `EXITED`, `FATAL`, unexpected
  states, and deadline expiry fail loudly. Shutdown polls terminal worker states
  and owned supervisord/socket disappearance; stale state is cleaned only after
  ownership/liveness checks.
- Stop, activation, start, controller status, and authenticated readiness now
  share one recovery boundary. If symlink creation or `os.replace` activation
  fails after an old stop, the installer validates, reactivates, restarts, and
  re-verifies the previous release. Recovery failure preserves all artifacts and
  raises `ROLLBACK FAILED`.
- Release build validation now occurs in inactive staging before `.complete` is
  created. The final marker is fsynced and only then is the release atomically
  moved under `releases/`. Manual rollback calls deep published-release
  validation, including release-tree safety, required models/services, Python
  versions/imports, and Supervisor availability; a marker alone is insufficient.
- Every install, start, stop, status, and rollback path rejects callers other
  than `heqing`, including root. Existing managed root/release/current/
  controller/runtime/token/log paths are lstat ownership-checked before lifecycle
  operations. Systemd uses the fixed `heqing` home rather than `Path.home()`.
- Controller metadata and service tokens now use same-directory exclusive,
  no-follow temporary files with mode `0600`, fsync, and atomic replacement. A
  pre-existing temporary file or symlink is rejected without deletion.
- `_install` transaction tests use a private bundle and fake host, Conda,
  controller, readiness, and verifier boundaries. They prove a successful
  first install flow, bundle mutation between initial verification and staging,
  activation rollback, no published marker after post-build validation failure,
  non-`heqing` rejection, foreign ownership rejection, and temporary-path
  attack rejection. Bats names the focused acceptance tests for Linux runs.

### Fresh Follow-up Verification

- `python -m unittest deploy.remote.tests.test_verify_assets
  deploy.remote.tests.test_deployment_lifecycle -v`: 73 tests ran successfully;
  6 skips require Windows symlink privilege or Linux Unix-socket behavior.
- Python compilation, Python 3.8 AST compatibility, Git for Windows `bash -n`,
  and whitespace checks are run with the final commit gate below.

### Follow-up External-Only Remainder

1. Bats and ShellCheck remain unavailable locally; run the checked-in Bats
   acceptance suite and ShellCheck on target-compatible Linux.
2. Native Linux symlink/socket behavior, actual `heqing` ownership metadata,
   user-systemd linger, and real Supervisor process ownership require the remote
   Ubuntu host.
3. Verified model snapshots/manifests, Linux hash locks, wheelhouses, offline
   Conda creation, GPU startup, and real systemd/Supervisor readiness remain
   external asset and host acceptance blockers.

## Phase B Lifecycle Race Re-review Evidence

Commit message: `fix: close deployment lifecycle races`

- RED command:
  `python -m unittest -v deploy.remote.tests.test_deployment_lifecycle.DeploymentLifecycleTests.test_supervisor_stop_retries_transient_status_failure_until_owned_state_disappears deploy.remote.tests.test_deployment_lifecycle.DeploymentLifecycleTests.test_lifecycle_entrypoints_reject_non_heqing_before_prepare_or_filesystem deploy.remote.tests.test_deployment_lifecycle.DeploymentLifecycleTests.test_activation_never_unlinks_preexisting_predictable_temp`
  failed all three confirmed regressions: transient Supervisor status failure
  escaped immediately, install invoked `prepare_install` for root, and activation
  deleted the pre-existing `.current.<pid>` path.
- GREEN command: the same three focused tests passed after the implementation;
  activation rollback coverage was also run in the same focused gate and passed.
- `SupervisorController._wait_stopped` now treats `supervisorctl status` command
  failure as a transient shutdown observation. It keeps bounded polling while an
  owned pid or socket remains, succeeds only after both disappear, and raises the
  existing deadline error when `stop_timeout` expires.
- `_install` now calls `_require_heqing()` before constructing paths or invoking
  `prepare_install`, so a non-`heqing` caller cannot read or verify bundle or
  deployment assets. The entry-order test records zero prepare calls.
- `activate_release` now generates 128-bit random same-directory temporary names,
  uses exclusive symlink creation, retries collisions without deleting them,
  preserves atomic `os.replace`, and cleans only the temporary link it created
  if replacement fails. Tests preserve a predictable attacker file and a random
  collision; the native Linux test also covers a pre-existing symlink and real
  activation.

### Exact Re-review Verification

- `python -m unittest deploy.remote.tests.test_verify_assets deploy.remote.tests.test_deployment_lifecycle -v`
  ran 76 tests successfully with 7 skips for Windows symlink privilege or native
  Linux Unix-socket/symlink behavior.
- `$env:PYTHONPYCACHEPREFIX=<fresh external temp>; python -m py_compile deploy/remote/verify-assets.py deploy/remote/deployment.py deploy/remote/tests/test_verify_assets.py deploy/remote/tests/test_deployment_lifecycle.py`
  passed. The external cache prefix avoided an access-denied untracked Windows
  cache file without changing or staging repository caches.
- `python -c "import ast, pathlib; [ast.parse(pathlib.Path(p).read_text(encoding='utf-8'), filename=p, feature_version=(3, 8)) for p in ('deploy/remote/verify-assets.py','deploy/remote/deployment.py')]"`
  passed.
- `C:/Program Files/Git/bin/bash.exe -n deploy/remote/install.sh deploy/remote/bin/rollback.sh deploy/remote/bin/run-embedding.sh deploy/remote/bin/run-ocr.sh deploy/remote/bin/start-all.sh deploy/remote/bin/status.sh deploy/remote/bin/stop-all.sh`
  passed.
- `git diff --check -- deploy/remote .superpowers/sdd/production-plan4-task4-report.md`
  passed.

External-only blockers remain unchanged: Bats/ShellCheck, native Linux ownership
and socket/symlink acceptance, real model manifests/locks/wheelhouses, and target
Ubuntu Conda/GPU/systemd/Supervisor acceptance.

## Phase B Activation Cleanup Identity Evidence

Commit message: `fix: guard activation cleanup identity`

- RED: `python -m unittest -v deploy.remote.tests.test_deployment_lifecycle.DeploymentLifecycleTests.test_activation_cleanup_preserves_attacker_replacement_after_replace_failure`
  failed because the unconditional error-path `unlink()` deleted the simulated
  attacker replacement installed after symlink creation and before failed
  `os.replace` cleanup.
- GREEN: the same focused regression passed together with
  `test_activation_never_unlinks_preexisting_predictable_temp`,
  `test_activation_failure_restores_previous_release_and_restarts_workers`, and
  `test_install_activation_failure_restores_previous_release_transactionally`.
- Activation records the created link's no-follow device, inode, file type, and
  exact relative target. Identity sampling uses `lstat`, `readlink`, and a second
  `lstat`; an unstable sample is rejected. Failed atomic replacement cleans only
  when an immediate recheck exactly matches that captured symlink identity.
  Missing, replaced, retargeted, or non-symlink paths are preserved.
- Collision retry and same-directory atomic `os.replace` activation remain
  unchanged. The regression replaces the path during failed replacement and
  confirms the attacker content remains.

### Exact Activation Cleanup Verification

- `python -m unittest deploy.remote.tests.test_verify_assets deploy.remote.tests.test_deployment_lifecycle -v`
  ran 77 tests successfully with 7 expected Windows/Linux capability skips.
- `$env:PYTHONPYCACHEPREFIX=<fresh external temp>; python -m py_compile deploy/remote/verify-assets.py deploy/remote/deployment.py deploy/remote/tests/test_verify_assets.py deploy/remote/tests/test_deployment_lifecycle.py`
  passed.
- `python -c "import ast, pathlib; [ast.parse(pathlib.Path(p).read_text(encoding='utf-8'), filename=p, feature_version=(3, 8)) for p in ('deploy/remote/verify-assets.py','deploy/remote/deployment.py')]"`
  passed.
- `C:/Program Files/Git/bin/bash.exe -n deploy/remote/install.sh deploy/remote/bin/rollback.sh deploy/remote/bin/run-embedding.sh deploy/remote/bin/run-ocr.sh deploy/remote/bin/start-all.sh deploy/remote/bin/status.sh deploy/remote/bin/stop-all.sh`
  passed.
- `git diff --check -- deploy/remote .superpowers/sdd/production-plan4-task4-report.md`
  passed.

External-only blockers remain unchanged.
