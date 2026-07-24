#!/usr/bin/env python3
"""Transactional installer and controller lifecycle for remote GPU workers."""

from __future__ import print_function

import argparse
import errno
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


CANONICAL_ROOT = Path("/home/heqing/resume-ai")
RELEASE_ID = re.compile(r"^[0-9a-f]{64}$")
SAFE_ROOT = re.compile(r"^/[A-Za-z0-9._/-]+$")
CONTROLLER_VERSION = 1
CONTROLLER_BACKENDS = ("systemd", "supervisor")
UNITS = ("resume-embedding.service", "resume-ocr.service")
MIN_FREE_KIB = 100 * 1024 * 1024
EMBEDDING_IDENTITY = {
    "status": "ready",
    "model": "Qwen/Qwen3-Embedding-8B",
    "modelRevision": "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af",
    "dimensions": 4096,
}
OCR_IDENTITY = {
    "status": "ready",
    "model": "deepseek-ai/DeepSeek-OCR-2",
    "modelRevision": "aaa02f3811945a91062062994c5c4a3f4c0af2b0",
}


class DeploymentError(RuntimeError):
    """Raised when deployment state cannot be changed safely."""


class RollbackError(DeploymentError):
    """Raised when a failed activation cannot be restored safely."""


class CommandError(DeploymentError):
    """Raised when a lifecycle command reports failure."""


class ControllerMetadata:
    def __init__(self, root: str, backend: str) -> None:
        self.root = root
        self.backend = backend


class InstallPlan:
    def __init__(
        self,
        root: Path,
        bundle: Path,
        asset_root: Path,
        bundle_fingerprint: str,
        deployment_id: str,
    ) -> None:
        self.root = root
        self.bundle = bundle
        self.asset_root = asset_root
        self.bundle_fingerprint = bundle_fingerprint
        self.deployment_id = deployment_id


def _run(
    arguments: Sequence[str],
    check: bool = True,
    capture_output: bool = False,
    env: Optional[Dict[str, str]] = None,
) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            list(arguments),
            check=check,
            capture_output=capture_output,
            text=True,
            env=env,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        command = Path(str(arguments[0])).name
        raise CommandError("{} command failed".format(command)) from error


def _load_verifier(asset_root: Path) -> Callable[[Path], str]:
    script = asset_root / "verify-assets.py"
    spec = importlib.util.spec_from_file_location("resume_ai_asset_verifier", str(script))
    if spec is None or spec.loader is None:
        raise DeploymentError("asset verifier is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.verify_bundle


def verify_assets(bundle: Path, asset_root: Path) -> str:
    try:
        fingerprint = _load_verifier(asset_root)(bundle)
    except Exception as error:
        if error.__class__.__name__ == "VerificationError":
            raise DeploymentError("asset verification failed: {}".format(error)) from error
        if isinstance(error, DeploymentError):
            raise
        raise DeploymentError("asset verification failed") from error
    if not RELEASE_ID.fullmatch(fingerprint):
        raise DeploymentError("asset verifier returned an invalid fingerprint")
    return fingerprint


def prepare_install(
    root: Path,
    bundle: Path,
    asset_root: Path,
    verifier: Optional[Callable[[Path], str]] = None,
    preflight: Optional[Callable[[InstallPlan], None]] = None,
) -> InstallPlan:
    verify = verifier or (lambda path: verify_assets(path, asset_root))
    bundle_fingerprint = verify(bundle)
    if not RELEASE_ID.fullmatch(bundle_fingerprint):
        raise DeploymentError("asset verifier returned an invalid fingerprint")

    validated_root = validate_root_path(root)
    deployment_id = deployment_fingerprint(asset_root, bundle_fingerprint)
    plan = InstallPlan(validated_root, bundle.resolve(), asset_root.resolve(), bundle_fingerprint, deployment_id)
    if preflight is not None:
        preflight(plan)
    return plan


def deployment_fingerprint(asset_root: Path, bundle_fingerprint: str) -> str:
    digest = hashlib.sha256(bundle_fingerprint.encode("ascii"))
    paths = [
        asset_root / "deployment.py",
        asset_root / "env.example",
        asset_root / "supervisord.conf",
    ]
    paths.extend(sorted((asset_root / "bin").glob("*.sh")))
    paths.extend(sorted((asset_root / "systemd").glob("*.service")))
    for path in paths:
        if not path.is_file() or path.is_symlink():
            raise DeploymentError("deployment asset is missing or unsafe: {}".format(path.name))
        relative = path.relative_to(asset_root).as_posix()
        digest.update(relative.encode("utf-8") + b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def validate_root_path(root: Path) -> Path:
    value = str(root)
    if (
        not SAFE_ROOT.fullmatch(value)
        or value == "/"
        or "//" in value
        or any(part in ("", ".", "..") or part.startswith("-") for part in root.parts[1:])
    ):
        raise DeploymentError("installation root is unsupported or unsafe")
    return root


def _lexists(path: Path) -> bool:
    return os.path.lexists(str(path))


def _lstat(path: Path) -> os.stat_result:
    try:
        return path.lstat()
    except OSError as error:
        raise DeploymentError("could not inspect managed path: {}".format(path)) from error


def _require_directory(path: Path, label: str, writable: bool = True) -> None:
    value = _lstat(path)
    if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode):
        raise DeploymentError("{} is unsafe: {}".format(label, path))
    if writable and not os.access(str(path), os.W_OK | os.X_OK):
        raise DeploymentError("{} is not writable: {}".format(label, path))


def _require_regular(path: Path, label: str) -> None:
    value = _lstat(path)
    if not stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode):
        raise DeploymentError("{} is unsafe: {}".format(label, path))


def nearest_existing_parent(path: Path) -> Path:
    candidate = path
    while not _lexists(candidate):
        if candidate.parent == candidate:
            raise DeploymentError("could not find target filesystem")
        candidate = candidate.parent
    _require_directory(candidate, "destination parent")
    return candidate


def _inspect_destination(path: Path, label: str, expect_directory: bool = True) -> None:
    if _lexists(path):
        if expect_directory:
            _require_directory(path, label)
        else:
            _require_regular(path, label)
    else:
        nearest_existing_parent(path)


def _validate_managed_link(path: Path, expected_target: str) -> None:
    if not _lexists(path):
        nearest_existing_parent(path)
        return
    value = _lstat(path)
    if not stat.S_ISLNK(value.st_mode) or os.readlink(str(path)) != expected_target:
        raise DeploymentError("managed runtime link is unsafe: {}".format(path))


def preflight_managed_paths(
    root: Path,
    release_id: str,
    destination_parent: Optional[Path] = None,
    conda_paths: Iterable[Path] = (),
    systemd_unit_directory: Optional[Path] = None,
) -> None:
    validate_root_path(root)
    if not RELEASE_ID.fullmatch(release_id):
        raise DeploymentError("release id must be lowercase 64-hex")
    parent = destination_parent or nearest_existing_parent(root)
    _require_directory(parent, "installation destination parent")
    if _lexists(root):
        _require_directory(root, "installation root")

    for name in (
        "releases",
        "staging",
        "envs",
        "models",
        "cache",
        "logs",
        "run",
        "tmp",
        "controller",
    ):
        _inspect_destination(root / name, "managed directory")
    candidate = root / "releases" / release_id
    _inspect_destination(candidate, "release directory")
    if _lexists(candidate):
        validate_release(root, release_id)
    releases = root / "releases"
    if _lexists(releases):
        for child in releases.iterdir():
            value = child.lstat()
            if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
                raise DeploymentError("releases contains an unsafe managed entry")
            if RELEASE_ID.fullmatch(child.name) is None:
                raise DeploymentError("releases contains an invalid release id")
            validate_release(root, child.name)

    _validate_managed_link(root / "envs" / "embedding", "../current/envs/embedding")
    _validate_managed_link(root / "envs" / "ocr", "../current/envs/ocr")
    _validate_managed_link(root / "models" / "Qwen3-Embedding-8B", "../current/models/Qwen3-Embedding-8B")
    _validate_managed_link(root / "models" / "DeepSeek-OCR-2", "../current/models/DeepSeek-OCR-2")
    _validate_managed_link(root / "services", "current/services")

    if _lexists(root / "current"):
        current_release_id(root)
    metadata = root / "controller" / "owner.json"
    if _lexists(metadata):
        load_controller_metadata(root)
    for token_name in ("embedding.token", "ocr.token"):
        token = root / "run" / token_name
        if _lexists(token):
            _require_regular(token, "token file")
    for run_name in ("supervisord.pid", "supervisor.sock"):
        run_path = root / "run" / run_name
        if _lexists(run_path):
            value = _lstat(run_path)
            allowed = stat.S_ISREG(value.st_mode)
            if run_name.endswith(".sock"):
                allowed = allowed or stat.S_ISSOCK(value.st_mode)
            if not allowed or stat.S_ISLNK(value.st_mode):
                raise DeploymentError("managed runtime file is unsafe: {}".format(run_path))
    for log_name in (
        "supervisord.log",
        "embedding.stdout.log",
        "embedding.stderr.log",
        "ocr.stdout.log",
        "ocr.stderr.log",
    ):
        log_path = root / "logs" / log_name
        if _lexists(log_path):
            _require_regular(log_path, "log file")
    for path in conda_paths:
        _inspect_destination(path, "Conda path")
    if systemd_unit_directory is not None:
        _inspect_destination(systemd_unit_directory, "systemd unit directory")
        for unit in UNITS:
            unit_path = systemd_unit_directory / unit
            if _lexists(unit_path):
                _require_regular(unit_path, "systemd unit")


class InstallLock:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.path: Optional[Path] = None
        self.handle = None

    def __enter__(self) -> "InstallLock":
        parent = nearest_existing_parent(self.root)
        if os.name != "nt":
            import fcntl

            flags = os.O_RDONLY
            if hasattr(os, "O_DIRECTORY"):
                flags |= os.O_DIRECTORY
            descriptor = os.open(str(parent), flags)
            self.handle = os.fdopen(descriptor, "rb")
            try:
                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (OSError, IOError) as error:
                self.handle.close()
                self.handle = None
                raise DeploymentError("another installation is already running") from error
            return self

        self.path = parent / ("." + self.root.name + ".install.lock")
        if _lexists(self.path):
            _require_regular(self.path, "install lock")
        flags = os.O_CREAT | os.O_RDWR
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(str(self.path), flags, 0o600)
            self.handle = os.fdopen(descriptor, "r+b")
            self.handle.seek(0, os.SEEK_END)
            if self.handle.tell() == 0:
                self.handle.write(b"\0")
                self.handle.flush()
            self.handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
        except (OSError, IOError) as error:
            if self.handle is not None:
                self.handle.close()
                self.handle = None
            raise DeploymentError("another installation is already running") from error
        return self

    def __exit__(self, _type, _value, _traceback) -> None:
        if self.handle is None or self.path is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()
            self.handle = None
        if os.name == "nt":
            try:
                self.path.unlink()
            except OSError as error:
                raise DeploymentError("install lock could not be released") from error


def stage_verified_bundle(
    bundle: Path,
    staging_parent: Path,
    expected_fingerprint: str,
    verifier: Callable[[Path], str],
) -> Path:
    temporary = Path(tempfile.mkdtemp(prefix="bundle-", dir=str(staging_parent)))
    snapshot = temporary / "snapshot"
    try:
        shutil.copytree(str(bundle), str(snapshot), symlinks=True)
        actual = verifier(snapshot)
        if actual != expected_fingerprint:
            raise DeploymentError("bundle changed while staging verified content")
        return snapshot
    except Exception:
        shutil.rmtree(str(temporary), ignore_errors=True)
        raise


def validate_release(root: Path, release_id: str) -> Path:
    if not RELEASE_ID.fullmatch(release_id):
        raise DeploymentError("release id must be lowercase 64-hex")
    releases = root / "releases"
    _require_directory(releases, "releases directory", writable=False)
    release = releases / release_id
    value = _lstat(release)
    if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode) or release.parent != releases:
        raise DeploymentError("release must be a direct non-symlink directory under releases")
    marker = release / ".complete"
    _require_regular(marker, "release completion marker")
    try:
        content = marker.read_bytes()
    except OSError as error:
        raise DeploymentError("release completion marker cannot be read") from error
    if content != (release_id + "\n").encode("ascii"):
        raise DeploymentError("release completion marker does not exactly match release id")
    return release


def current_release_id(root: Path) -> Optional[str]:
    current = root / "current"
    if not _lexists(current):
        return None
    value = _lstat(current)
    if not stat.S_ISLNK(value.st_mode):
        raise DeploymentError("current must be a managed symbolic link")
    target = os.readlink(str(current))
    match = re.fullmatch(r"releases/([0-9a-f]{64})", target)
    if match is None:
        raise DeploymentError("current does not target a strict managed release")
    release_id = match.group(1)
    validate_release(root, release_id)
    return release_id


def activate_release(root: Path, release_id: str) -> None:
    validate_release(root, release_id)
    temporary = root / (".current.{}".format(os.getpid()))
    if _lexists(temporary):
        temporary.unlink()
    temporary.symlink_to(Path("releases") / release_id, target_is_directory=True)
    os.replace(str(temporary), str(root / "current"))


def _remove_current(root: Path) -> None:
    current = root / "current"
    if _lexists(current):
        current.unlink()


def transactional_activate(
    root: Path,
    release_id: str,
    controller: Any,
    readiness_check: Callable[[str], None],
) -> None:
    validate_release(root, release_id)
    previous = current_release_id(root)
    if previous is not None:
        controller.stop()
    activate_release(root, release_id)
    try:
        controller.start()
        controller.status()
        readiness_check(release_id)
        return
    except Exception as startup_error:
        try:
            controller.stop()
        except Exception as stop_error:
            raise RollbackError(
                "ROLLBACK FAILED: partial new processes could not be stopped; "
                "current and all release artifacts were preserved"
            ) from stop_error

        if previous is None:
            _remove_current(root)
            raise DeploymentError("services failed to start; no previous release existed") from startup_error

        try:
            validate_release(root, previous)
            activate_release(root, previous)
            controller.start()
            controller.status()
            readiness_check(previous)
        except Exception as rollback_error:
            raise RollbackError(
                "ROLLBACK FAILED: previous release could not be restored and verified; "
                "all release artifacts were preserved"
            ) from rollback_error
        raise DeploymentError("services failed to start; previous release restored and verified") from startup_error


def controller_metadata_path(root: Path) -> Path:
    return root / "controller" / "owner.json"


def load_controller_metadata(root: Path) -> Optional[ControllerMetadata]:
    path = controller_metadata_path(root)
    if not _lexists(path):
        return None
    _require_regular(path, "controller ownership metadata")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        raise DeploymentError("controller ownership metadata is invalid") from error
    if not isinstance(value, dict) or set(value) != {"version", "root", "backend"}:
        raise DeploymentError("controller ownership metadata is invalid")
    if value.get("version") != CONTROLLER_VERSION or value.get("root") != str(root):
        raise DeploymentError("controller ownership metadata does not match this root")
    backend = value.get("backend")
    if backend not in CONTROLLER_BACKENDS:
        raise DeploymentError("controller ownership metadata has an unsupported backend")
    if backend == "systemd" and root != CANONICAL_ROOT:
        raise DeploymentError("systemd controller ownership is limited to the canonical root")
    return ControllerMetadata(str(root), backend)


def persist_controller_metadata(root: Path, backend: str) -> None:
    if backend not in CONTROLLER_BACKENDS:
        raise DeploymentError("unsupported controller backend")
    if backend == "systemd" and root != CANONICAL_ROOT:
        raise DeploymentError("systemd is allowed only for the canonical root")
    directory = root / "controller"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = controller_metadata_path(root)
    temporary = directory / (".owner.{}".format(os.getpid()))
    payload = {"version": CONTROLLER_VERSION, "root": str(root), "backend": backend}
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
    os.chmod(str(temporary), 0o600)
    os.replace(str(temporary), str(path))


def systemd_available(run: Callable[..., Any] = _run) -> bool:
    if shutil.which("systemctl") is None or shutil.which("loginctl") is None:
        return False
    try:
        run(["systemctl", "--user", "show-environment"], capture_output=True)
        user = run(["id", "-un"], capture_output=True).stdout.strip()
        linger = run(
            ["loginctl", "show-user", user, "--property=Linger", "--value"],
            capture_output=True,
        ).stdout.strip()
        return linger == "yes"
    except DeploymentError:
        return False


def select_controller(
    root: Path,
    existing: Optional[ControllerMetadata],
    systemd_probe: Callable[[], bool],
) -> str:
    if existing is not None:
        if existing.root != str(root):
            raise DeploymentError("controller ownership metadata does not match this root")
        if existing.backend not in CONTROLLER_BACKENDS:
            raise DeploymentError("controller ownership metadata has an unsupported backend")
        if existing.backend == "systemd" and root != CANONICAL_ROOT:
            raise DeploymentError("systemd is allowed only for the canonical root")
        return existing.backend
    if root == CANONICAL_ROOT and systemd_probe():
        return "systemd"
    return "supervisor"


class SystemdController:
    def __init__(
        self,
        root: Path,
        run: Callable[..., Any] = _run,
        home: Optional[Path] = None,
    ) -> None:
        if root != CANONICAL_ROOT:
            raise DeploymentError("systemd is allowed only for the canonical root")
        self.root = root
        self.run = run
        self.home = home or Path.home()

    def start(self) -> None:
        unit_directory = self.home / ".config" / "systemd" / "user"
        _inspect_destination(unit_directory, "systemd unit directory")
        for unit in UNITS:
            source = self.root / "services" / "systemd" / unit
            _require_regular(source, "managed systemd unit")
            destination = unit_directory / unit
            if _lexists(destination):
                _require_regular(destination, "installed systemd unit")
        unit_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for unit in UNITS:
            source = self.root / "services" / "systemd" / unit
            destination = unit_directory / unit
            shutil.copyfile(str(source), str(destination), follow_symlinks=False)
            os.chmod(str(destination), 0o600)
        self.run(["systemctl", "--user", "daemon-reload"])
        self.run(["systemctl", "--user", "enable", "--now"] + list(UNITS))

    def stop(self) -> None:
        self.run(["systemctl", "--user", "stop"] + list(UNITS))

    def status(self) -> None:
        self.run(["systemctl", "--user", "status"] + list(UNITS) + ["--no-pager"])


def _default_process_is_owned(pid: int, config: Path) -> bool:
    if pid <= 1:
        return False
    try:
        os.kill(pid, 0)
    except OSError as error:
        if error.errno == errno.ESRCH:
            return False
        if error.errno != errno.EPERM:
            return False
    command_line = Path("/proc") / str(pid) / "cmdline"
    try:
        values = command_line.read_bytes().split(b"\0")
    except OSError:
        return False
    return str(config).encode("utf-8") in values and any(b"supervisord" in value for value in values)


def cleanup_stale_supervisor_state(
    root: Path,
    process_is_owned: Callable[[int, Path], bool] = _default_process_is_owned,
) -> None:
    pid_path = root / "run" / "supervisord.pid"
    socket_path = root / "run" / "supervisor.sock"
    config = root / "services" / "supervisord.conf"
    if _lexists(pid_path):
        _require_regular(pid_path, "Supervisor pid file")
        try:
            raw_pid = pid_path.read_text(encoding="ascii").strip()
            pid = int(raw_pid)
        except (OSError, UnicodeError, ValueError) as error:
            raise DeploymentError("Supervisor pid file is invalid") from error
        if process_is_owned(pid, config):
            raise DeploymentError("owned Supervisor process is still running")
        pid_path.unlink()
    if _lexists(socket_path):
        value = _lstat(socket_path)
        if stat.S_ISLNK(value.st_mode):
            raise DeploymentError("Supervisor socket path is unsafe")
        if not (stat.S_ISSOCK(value.st_mode) or stat.S_ISREG(value.st_mode)):
            raise DeploymentError("Supervisor socket path is unsafe")
        if stat.S_ISSOCK(value.st_mode):
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.settimeout(0.2)
                probe.connect(str(socket_path))
            except OSError:
                pass
            else:
                raise DeploymentError("Supervisor socket is still live")
            finally:
                probe.close()
        socket_path.unlink()


class SupervisorController:
    def __init__(
        self,
        root: Path,
        run: Callable[..., Any] = _run,
        process_is_owned: Callable[[int, Path], bool] = _default_process_is_owned,
    ) -> None:
        self.root = root
        self.run = run
        self.process_is_owned = process_is_owned
        self.config = root / "services" / "supervisord.conf"
        self.supervisord = root / "envs" / "embedding" / "bin" / "supervisord"
        self.supervisorctl = root / "envs" / "embedding" / "bin" / "supervisorctl"

    def _environment(self) -> Dict[str, str]:
        environment = os.environ.copy()
        environment["RESUME_AI_ROOT"] = str(self.root)
        return environment

    def _owned_running(self) -> bool:
        pid_path = self.root / "run" / "supervisord.pid"
        if not _lexists(pid_path):
            return False
        _require_regular(pid_path, "Supervisor pid file")
        try:
            pid = int(pid_path.read_text(encoding="ascii").strip())
        except (OSError, UnicodeError, ValueError) as error:
            raise DeploymentError("Supervisor pid file is invalid") from error
        return self.process_is_owned(pid, self.config)

    def start(self) -> None:
        if self._owned_running():
            self.status()
            return
        cleanup_stale_supervisor_state(self.root, self.process_is_owned)
        if not os.access(str(self.supervisord), os.X_OK):
            raise DeploymentError("Supervisor is unavailable in the embedding environment")
        self.run([str(self.supervisord), "-c", str(self.config)], env=self._environment())

    def stop(self) -> None:
        if not self._owned_running():
            cleanup_stale_supervisor_state(self.root, self.process_is_owned)
            return
        if not os.access(str(self.supervisorctl), os.X_OK):
            raise DeploymentError("supervisorctl is unavailable in the embedding environment")
        self.run(
            [str(self.supervisorctl), "-c", str(self.config), "shutdown"],
            env=self._environment(),
        )

    def status(self) -> None:
        if not self._owned_running():
            raise DeploymentError("owned Supervisor process is not running")
        result = self.run(
            [str(self.supervisorctl), "-c", str(self.config), "status"],
            env=self._environment(),
            capture_output=True,
        )
        states = {}
        for line in result.stdout.splitlines():
            fields = line.split()
            if len(fields) >= 2:
                states[fields[0]] = fields[1]
        expected = {"resume-embedding": "RUNNING", "resume-ocr": "RUNNING"}
        if states != expected:
            raise DeploymentError("Supervisor does not report both owned workers RUNNING")


def controller_for(root: Path, metadata: ControllerMetadata) -> Any:
    if metadata.root != str(root):
        raise DeploymentError("controller ownership metadata does not match this root")
    if metadata.backend == "systemd":
        return SystemdController(root)
    if metadata.backend == "supervisor":
        return SupervisorController(root)
    raise DeploymentError("unsupported controller backend")


def _read_token(path: Path) -> str:
    _require_regular(path, "service token")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode != 0o600:
        raise DeploymentError("service token must have mode 0600")
    try:
        value = path.read_text(encoding="ascii")
    except (OSError, UnicodeError) as error:
        raise DeploymentError("service token is invalid") from error
    if re.fullmatch(r"[A-Za-z0-9_-]{64}\n", value) is None:
        raise DeploymentError("service token is invalid")
    return value.rstrip("\n")


def _ready_response(port: int, token: str) -> Dict[str, Any]:
    request = Request(
        "http://127.0.0.1:{}/readyz".format(port),
        headers={"Authorization": "Bearer " + token},
    )
    with urlopen(request, timeout=5) as response:
        if response.status != 200:
            raise DeploymentError("worker readiness check failed")
        value = json.loads(response.read().decode("utf-8"))
    if not isinstance(value, dict):
        raise DeploymentError("worker readiness response is invalid")
    return value


def verify_workers_ready(root: Path, _release_id: str, timeout: Optional[float] = None) -> None:
    deadline = time.monotonic() + (timeout if timeout is not None else float(os.environ.get("RESUME_AI_READY_TIMEOUT", "300")))
    embedding_token = _read_token(root / "run" / "embedding.token")
    ocr_token = _read_token(root / "run" / "ocr.token")
    last_error = None
    while time.monotonic() < deadline:
        try:
            embedding = _ready_response(18080, embedding_token)
            ocr = _ready_response(43121, ocr_token)
            if embedding != EMBEDDING_IDENTITY:
                raise DeploymentError("embedding worker model identity does not match")
            if ocr != OCR_IDENTITY:
                raise DeploymentError("OCR worker model identity does not match")
            return
        except (DeploymentError, HTTPError, URLError, OSError, ValueError) as error:
            last_error = error
            time.sleep(1)
    raise DeploymentError("both workers did not become ready with pinned model identities") from last_error


def _host_preflight() -> None:
    if _run(["uname", "-s"], capture_output=True).stdout.strip() != "Linux":
        raise DeploymentError("Ubuntu Linux is required")
    if _run(["uname", "-m"], capture_output=True).stdout.strip() != "x86_64":
        raise DeploymentError("x86-64 is required")
    if _run(["id", "-un"], capture_output=True).stdout.strip() != "heqing":
        raise DeploymentError("installer must run as user heqing")
    os_release = Path(os.environ.get("RESUME_AI_OS_RELEASE", "/etc/os-release"))
    _require_regular(os_release, "Ubuntu release metadata")
    values = {}
    for line in os_release.read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value.strip('"')
    if values.get("ID") != "ubuntu" or values.get("VERSION_ID") != "20.04":
        raise DeploymentError("Ubuntu 20.04 is required")
    gpu_rows = _run(
        ["nvidia-smi", "--query-gpu=index", "--format=csv,noheader,nounits"],
        capture_output=True,
    ).stdout.splitlines()
    if "5" not in [row.strip() for row in gpu_rows]:
        raise DeploymentError("physical GPU 5 is not visible")


def _conda_preflight(conda: str, python_bin: str) -> List[Path]:
    info = _run([conda, "info", "--json"], capture_output=True)
    try:
        value = json.loads(info.stdout)
    except ValueError as error:
        raise DeploymentError("Conda path metadata is invalid") from error
    paths = []
    for key in ("envs_dirs", "pkgs_dirs"):
        entries = value.get(key, [])
        if not isinstance(entries, list):
            raise DeploymentError("Conda path metadata is invalid")
        for entry in entries:
            if not isinstance(entry, str) or not entry:
                raise DeploymentError("Conda path metadata is invalid")
            paths.append(Path(entry))
    for version in ("3.10", "3.12"):
        search = _run([conda, "search", "--offline", "--json", "python=" + version], capture_output=True)
        try:
            result = json.loads(search.stdout)
        except ValueError as error:
            raise DeploymentError("Conda has no offline Python {} package".format(version)) from error
        if not isinstance(result, dict) or not any(result.values()):
            raise DeploymentError("Conda has no offline Python {} package".format(version))
    if shutil.which(python_bin) is None:
        raise DeploymentError("python3 is required for verification")
    return paths


def _disk_preflight(parent: Path) -> None:
    usage = shutil.disk_usage(str(parent))
    required_kib = int(os.environ.get("RESUME_AI_MIN_FREE_KIB", str(MIN_FREE_KIB)))
    if required_kib < 1:
        raise DeploymentError("minimum free disk requirement is invalid")
    if usage.free // 1024 < required_kib:
        raise DeploymentError("at least 100 GiB free is required")


def _create_stable_directories(root: Path) -> None:
    for path in (
        root,
        root / "releases",
        root / "staging",
        root / "envs",
        root / "models",
        root / "cache",
        root / "logs",
        root / "run",
        root / "tmp",
        root / "controller",
    ):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    for path in (root / "cache", root / "logs", root / "run", root / "tmp", root / "controller"):
        os.chmod(str(path), 0o700)


def _copy_services(asset_root: Path, release: Path) -> None:
    services = release / "services"
    shutil.copytree(str(asset_root / "bin"), str(services / "bin"), symlinks=True)
    shutil.copytree(str(asset_root / "systemd"), str(services / "systemd"), symlinks=True)
    for name in ("deployment.py", "verify-assets.py", "supervisord.conf", "env.example"):
        shutil.copy2(str(asset_root / name), str(services / name), follow_symlinks=False)
    for script in (services / "bin").glob("*.sh"):
        os.chmod(str(script), 0o700)
    os.chmod(str(services / "deployment.py"), 0o700)


def _create_environment(
    conda: str,
    snapshot: Path,
    release: Path,
    name: str,
    version: str,
    worker_directory: str,
    import_module: str,
) -> None:
    prefix = release / "envs" / name
    worker = snapshot / "workers" / worker_directory
    manifest = json.loads((worker / "worker-manifest.json").read_text(encoding="utf-8"))
    wheel = worker / manifest["wheel"]
    _run([conda, "create", "--yes", "--offline", "--prefix", str(prefix), "python=" + version, "pip"])
    _run(
        [
            conda,
            "run",
            "--no-capture-output",
            "--prefix",
            str(prefix),
            "python",
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-index",
            "--no-deps",
            "--require-hashes",
            "--find-links",
            str(worker / "wheelhouse"),
            "-r",
            str(worker / "requirements.lock"),
        ]
    )
    _run(
        [
            conda,
            "run",
            "--no-capture-output",
            "--prefix",
            str(prefix),
            "python",
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-index",
            "--no-deps",
            str(wheel),
        ]
    )
    _run(
        [
            conda,
            "run",
            "--no-capture-output",
            "--prefix",
            str(prefix),
            "python",
            "-c",
            "import sys; assert sys.version_info[:2] == tuple(map(int, {!r}.split('.'))); import {}".format(
                version, import_module
            ),
        ]
    )


def _build_release(conda: str, snapshot: Path, asset_root: Path, release: Path, release_id: str) -> None:
    build_root = snapshot.parent / "release"
    try:
        build_root.mkdir(mode=0o700)
        (build_root / "envs").mkdir(mode=0o700)
        (build_root / "models").mkdir(mode=0o700)
        _create_environment(
            conda,
            snapshot,
            build_root,
            "embedding",
            "3.10",
            "embedding-worker",
            "resume_embedding_worker.main",
        )
        _create_environment(
            conda,
            snapshot,
            build_root,
            "ocr",
            "3.12",
            "ocr-worker",
            "resume_ocr_worker.main",
        )
        if not os.access(str(build_root / "envs" / "embedding" / "bin" / "supervisord"), os.X_OK):
            raise DeploymentError("embedding lock must install Supervisor for the fallback launcher")
        for model in ("Qwen3-Embedding-8B", "DeepSeek-OCR-2"):
            shutil.copytree(
                str(snapshot / "models" / model),
                str(build_root / "models" / model),
                symlinks=True,
            )
        _copy_services(asset_root, build_root)
        marker = build_root / ".complete"
        marker.write_bytes((release_id + "\n").encode("ascii"))
        os.chmod(str(marker), 0o600)
        os.rename(str(build_root), str(release))
    except Exception:
        shutil.rmtree(str(build_root), ignore_errors=True)
        raise


def _directory_digest(root: Path) -> str:
    _require_directory(root, "release validation directory", writable=False)
    digest = hashlib.sha256()
    for current, directory_names, file_names in os.walk(str(root), followlinks=False):
        current_path = Path(current)
        directory_names.sort()
        file_names.sort()
        for name in directory_names:
            path = current_path / name
            value = path.lstat()
            if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
                raise DeploymentError("installed release contains an unsafe directory")
            digest.update(b"D\0" + path.relative_to(root).as_posix().encode("utf-8") + b"\0")
        for name in file_names:
            path = current_path / name
            value = path.lstat()
            if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode):
                raise DeploymentError("installed release contains an unsafe file")
            digest.update(b"F\0" + path.relative_to(root).as_posix().encode("utf-8") + b"\0")
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            digest.update(b"\0")
    return digest.hexdigest()


def validate_installed_release(snapshot: Path, asset_root: Path, release: Path) -> None:
    for model in ("Qwen3-Embedding-8B", "DeepSeek-OCR-2"):
        source = snapshot / "models" / model
        installed = release / "models" / model
        if _directory_digest(source) != _directory_digest(installed):
            raise DeploymentError("installed model does not match the verified snapshot")
    for name in ("bin", "systemd"):
        if _directory_digest(asset_root / name) != _directory_digest(release / "services" / name):
            raise DeploymentError("installed service assets do not match deployment assets")
    for name in ("deployment.py", "verify-assets.py", "supervisord.conf", "env.example"):
        source = asset_root / name
        installed = release / "services" / name
        _require_regular(installed, "installed service asset")
        if source.read_bytes() != installed.read_bytes():
            raise DeploymentError("installed service assets do not match deployment assets")
    for name, version, module in (
        ("embedding", "3.10", "resume_embedding_worker.main"),
        ("ocr", "3.12", "resume_ocr_worker.main"),
    ):
        python = release / "envs" / name / "bin" / "python"
        if not os.access(str(python), os.X_OK):
            raise DeploymentError("installed {} environment is unavailable".format(name))
        _run(
            [
                str(python),
                "-c",
                "import sys; assert sys.version_info[:2] == tuple(map(int, {!r}.split('.'))); import {}".format(
                    version, module
                ),
            ]
        )
    if not os.access(str(release / "envs" / "embedding" / "bin" / "supervisord"), os.X_OK):
        raise DeploymentError("Supervisor is missing from the embedding environment")


def _ensure_link(path: Path, target: str) -> None:
    if _lexists(path):
        _validate_managed_link(path, target)
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.parent / (".{}.{}".format(path.name, os.getpid()))
    temporary.symlink_to(target, target_is_directory=True)
    os.replace(str(temporary), str(path))


def _ensure_runtime_links(root: Path) -> None:
    _ensure_link(root / "envs" / "embedding", "../current/envs/embedding")
    _ensure_link(root / "envs" / "ocr", "../current/envs/ocr")
    _ensure_link(root / "models" / "Qwen3-Embedding-8B", "../current/models/Qwen3-Embedding-8B")
    _ensure_link(root / "models" / "DeepSeek-OCR-2", "../current/models/DeepSeek-OCR-2")
    _ensure_link(root / "services", "current/services")


def _ensure_token(path: Path) -> None:
    if _lexists(path):
        _read_token(path)
        return
    temporary = path.parent / (".{}.{}".format(path.name, os.getpid()))
    temporary.write_text(secrets.token_urlsafe(48) + "\n", encoding="ascii")
    os.chmod(str(temporary), 0o600)
    os.replace(str(temporary), str(path))
    _read_token(path)


def _install(arguments: argparse.Namespace, asset_root: Path) -> None:
    root_arg = Path(arguments.root)
    bundle_arg = Path(arguments.bundle)
    conda = os.environ.get("CONDA_EXE", "conda")
    python_bin = os.environ.get("PYTHON_BIN", "python3")

    plan = prepare_install(root_arg, bundle_arg, asset_root)
    with InstallLock(plan.root):
        _host_preflight()
        conda_paths = _conda_preflight(conda, python_bin)
        parent = nearest_existing_parent(plan.root)
        _disk_preflight(parent)
        preflight_managed_paths(
            plan.root,
            plan.deployment_id,
            parent,
            conda_paths=conda_paths,
        )
        existing_metadata = load_controller_metadata(plan.root) if _lexists(plan.root) else None
        backend = select_controller(plan.root, existing_metadata, systemd_available)
        unit_directory = Path.home() / ".config" / "systemd" / "user" if backend == "systemd" else None
        if unit_directory is not None:
            _inspect_destination(unit_directory, "systemd unit directory")
            for unit in UNITS:
                unit_path = unit_directory / unit
                if _lexists(unit_path):
                    _require_regular(unit_path, "systemd unit")

        _create_stable_directories(plan.root)
        snapshot = stage_verified_bundle(
            plan.bundle,
            plan.root / "staging",
            plan.bundle_fingerprint,
            lambda path: verify_assets(path, plan.asset_root),
        )
        release = plan.root / "releases" / plan.deployment_id
        try:
            if _lexists(release):
                validate_release(plan.root, plan.deployment_id)
            else:
                _build_release(conda, snapshot, plan.asset_root, release, plan.deployment_id)
                validate_release(plan.root, plan.deployment_id)
            validate_installed_release(snapshot, plan.asset_root, release)
            _ensure_runtime_links(plan.root)
            _ensure_token(plan.root / "run" / "embedding.token")
            _ensure_token(plan.root / "run" / "ocr.token")
            persist_controller_metadata(plan.root, backend)
            controller = controller_for(plan.root, ControllerMetadata(str(plan.root), backend))
            transactional_activate(
                plan.root,
                plan.deployment_id,
                controller,
                lambda release_id: verify_workers_ready(plan.root, release_id),
            )
        finally:
            shutil.rmtree(str(snapshot.parent), ignore_errors=True)

    print("Installation active at {}".format(plan.root / "current"))
    print("Embedding token file: {}".format(plan.root / "run" / "embedding.token"))
    print("OCR token file: {}".format(plan.root / "run" / "ocr.token"))


def _load_owned_controller(root: Path) -> Any:
    validate_root_path(root)
    _require_directory(root, "installation root")
    metadata = load_controller_metadata(root)
    if metadata is None:
        raise DeploymentError("controller ownership metadata is missing")
    return controller_for(root, metadata)


def _control(command: str, root: Path) -> None:
    controller = _load_owned_controller(root)
    if command == "start":
        release_id = current_release_id(root)
        if release_id is None:
            raise DeploymentError("no active release exists")
        controller.start()
        verify_workers_ready(root, release_id)
        print("Both workers started and verified.")
    elif command == "stop":
        controller.stop()
        print("Both workers stopped.")
    else:
        controller.status()
        release_id = current_release_id(root)
        if release_id is None:
            raise DeploymentError("no active release exists")
        verify_workers_ready(root, release_id, timeout=5)


def _rollback(root: Path, release_id: str) -> None:
    validate_root_path(root)
    with InstallLock(root):
        current = current_release_id(root)
        if current is None:
            raise DeploymentError("no active release exists")
        validate_release(root, release_id)
        preflight_managed_paths(root, release_id)
        controller = _load_owned_controller(root)
        transactional_activate(
            root,
            release_id,
            controller,
            lambda active_id: verify_workers_ready(root, active_id),
        )
    print("Rollback active at {}".format(root / "current"))


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command")
    install = subparsers.add_parser("install")
    install.add_argument("--root", default=str(CANONICAL_ROOT))
    install.add_argument("--bundle", required=True)
    for command in ("start", "stop", "status"):
        control = subparsers.add_parser(command)
        control.add_argument("--root", default=os.environ.get("RESUME_AI_ROOT", str(CANONICAL_ROOT)))
    rollback = subparsers.add_parser("rollback")
    rollback.add_argument("--root", default=os.environ.get("RESUME_AI_ROOT", str(CANONICAL_ROOT)))
    rollback.add_argument("--release", required=True)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    arguments = _parser().parse_args(argv)
    if arguments.command is None:
        _parser().print_usage(sys.stderr)
        return 2
    asset_root = Path(__file__).resolve().parent
    try:
        if arguments.command == "install":
            _install(arguments, asset_root)
        elif arguments.command == "rollback":
            _rollback(Path(arguments.root), arguments.release)
        else:
            _control(arguments.command, Path(arguments.root))
    except DeploymentError as error:
        print("deployment: {}".format(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
