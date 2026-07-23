import hashlib
import hmac
import json
import os
import re
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .types import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_DTYPE,
    EMBEDDING_MODEL,
    EMBEDDING_REVISION,
    MAX_EMPTY_REQUEST_BODY_FRAMES,
    MAX_REQUEST_BYTES,
    MAX_TEXT_CHARACTERS,
    WorkerSettings,
)


_GPU = "5"
_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
_WINDOWS_READ_ACCESS = frozenset({"F", "M", "RX", "R"})


@dataclass(frozen=True)
class OfflineWorkerSettings(WorkerSettings):
    model_path: Path = Path(".")
    manifest_path: Path = Path("model-manifest.json")
    cuda_visible_devices: str = _GPU
    batch_size: int = 32


Settings = OfflineWorkerSettings


def load_settings(environ: Mapping[str, str] | None = None) -> OfflineWorkerSettings:
    values = os.environ if environ is None else environ
    cuda_visible_devices = values.get("CUDA_VISIBLE_DEVICES")
    if cuda_visible_devices != _GPU:
        raise ValueError("CUDA_VISIBLE_DEVICES must be exactly '5'.")

    host = values.get("EMBEDDING_HOST", DEFAULT_HOST)
    if host != DEFAULT_HOST:
        raise ValueError("Embedding worker host must be loopback 127.0.0.1.")

    model = values.get("EMBEDDING_MODEL", EMBEDDING_MODEL)
    revision = values.get("EMBEDDING_MODEL_REVISION", EMBEDDING_REVISION)
    dimensions = _positive_int(values.get("EMBEDDING_DIMENSIONS", str(EMBEDDING_DIMENSIONS)), "dimensions")
    if model != EMBEDDING_MODEL:
        raise ValueError("Embedding model is not pinned.")
    if revision != EMBEDDING_REVISION:
        raise ValueError("Embedding model revision is not pinned.")
    if dimensions != EMBEDDING_DIMENSIONS:
        raise ValueError("Embedding dimensions are not pinned.")

    model_path = _required_directory(values.get("EMBEDDING_MODEL_PATH"), "model directory")
    manifest_path = model_path / "model-manifest.json"
    _validate_manifest(manifest_path, model_path, model, revision, dimensions)

    token_path = _required_file(values.get("EMBEDDING_API_TOKEN_FILE"), "token file")
    if not _has_secure_token_permissions(token_path):
        raise ValueError("Embedding API token file must have mode 0600.")
    api_token = token_path.read_text(encoding="utf-8").strip()
    if not api_token:
        raise ValueError("Embedding API token file must not be empty.")

    return OfflineWorkerSettings(
        api_token=api_token,
        model_path=model_path,
        manifest_path=manifest_path,
        cuda_visible_devices=cuda_visible_devices,
        batch_size=_positive_int(values.get("EMBEDDING_BATCH_SIZE", "32"), "batch size"),
        host=host,
        port=_bounded_port(values.get("EMBEDDING_PORT", str(DEFAULT_PORT))),
        model=model,
        revision=revision,
        dimensions=dimensions,
    )


def _required_directory(raw_path: str | None, label: str) -> Path:
    if not raw_path:
        raise ValueError(f"{label} is required.")
    path = Path(raw_path).expanduser()
    if not path.is_dir():
        raise ValueError(f"{label} does not exist.")
    return path.resolve()


def _required_file(raw_path: str | None, label: str) -> Path:
    if not raw_path:
        raise ValueError(f"{label} is required.")
    path = Path(raw_path).expanduser()
    if not path.is_file():
        raise ValueError(f"{label} does not exist.")
    return path.resolve()


def _positive_int(raw_value: str, label: str) -> int:
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label} must be an integer.") from error
    if value <= 0:
        raise ValueError(f"{label} must be positive.")
    return value


def _bounded_port(raw_value: str) -> int:
    port = _positive_int(raw_value, "port")
    if port != DEFAULT_PORT:
        raise ValueError("Embedding worker port must be 18080.")
    return port


def _has_secure_token_permissions(path: Path) -> bool:
    if os.name != "nt":
        return stat.S_IMODE(path.stat().st_mode) == 0o600

    # Windows does not expose POSIX mode bits. Treat a non-inherited ACL with
    # full control granted only to the current user as the 0600 equivalent.
    try:
        result = subprocess.run(
            ["icacls", str(path)],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError:
        return False
    if result.returncode != 0:
        return False
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        return False
    username = os.environ.get("USERNAME", "")
    if not username:
        return False

    current_user_has_access = False
    for line in lines:
        if line.lower().startswith("successfully processed"):
            continue
        if line.startswith(str(path)):
            line = line[len(str(path)) :].strip()
        principal, separator, rights = line.rpartition(":")
        if separator != ":":
            continue
        flags = {flag.upper() for flag in re.findall(r"\(([^()]*)\)", rights)}
        if "DENY" in flags or not flags & _WINDOWS_READ_ACCESS:
            continue
        is_current_user = principal.casefold() == username.casefold() or principal.casefold().endswith(
            f"\\{username.casefold()}"
        )
        if not is_current_user:
            return False
        current_user_has_access = True

    return current_user_has_access


def _validate_manifest(
    manifest_path: Path,
    model_path: Path,
    model: str,
    revision: str,
    dimensions: int,
) -> None:
    if not manifest_path.is_file():
        raise ValueError("model-manifest.json is required.")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("model-manifest.json is invalid.") from error

    if not isinstance(manifest, dict):
        raise ValueError("model-manifest.json must contain an object.")
    if (
        manifest.get("model") != model
        or manifest.get("revision") != revision
        or manifest.get("dimensions") != dimensions
    ):
        raise ValueError("model-manifest.json identity does not match pinned settings.")

    files = manifest.get("files")
    if not isinstance(files, list):
        raise ValueError("model-manifest.json files must be a list.")
    if not files:
        raise ValueError("model-manifest.json must list at least one model file.")
    listed_files: set[Path] = set()
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("model-manifest.json contains an invalid file entry.")
        relative_path = Path(item["path"])
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise ValueError("model-manifest.json contains an unsafe file path.")
        if relative_path in listed_files:
            raise ValueError("model-manifest.json contains a duplicate file entry.")
        listed_files.add(relative_path)
        expected_hash = item.get("sha256")
        if not isinstance(expected_hash, str) or not _SHA256.fullmatch(expected_hash):
            raise ValueError("model-manifest.json contains an invalid hash.")
        file_path = (model_path / relative_path).resolve()
        try:
            file_path.relative_to(model_path)
        except ValueError as error:
            raise ValueError("model-manifest.json contains an unsafe file path.") from error
        if not file_path.is_file():
            raise ValueError("model-manifest.json references a missing file.")
        actual_hash = hashlib.sha256(file_path.read_bytes()).hexdigest()
        if not hmac.compare_digest(actual_hash, expected_hash.lower()):
            raise ValueError("model-manifest.json file hash does not match.")

    actual_files = {
        file_path.relative_to(model_path)
        for file_path in model_path.rglob("*")
        if file_path.is_file() and file_path.resolve() != manifest_path
    }
    if listed_files != actual_files:
        raise ValueError("model-manifest.json does not cover all model files.")
