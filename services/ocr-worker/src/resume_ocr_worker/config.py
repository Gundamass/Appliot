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

from .types import DEFAULT_HOST, DEFAULT_PORT, OCR_MODEL, OCR_REVISION, WorkerSettings


_GPU = "5"
_DEVICE = "cuda:0"
_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
_WINDOWS_READ_ACCESS = frozenset({"F", "M", "RX", "R"})


@dataclass(frozen=True)
class OfflineOcrSettings(WorkerSettings):
    model_path: Path = Path(".")
    manifest_path: Path = Path("model-manifest.json")
    temp_dir: Path = Path.home() / "resume-ai" / "tmp"
    cuda_visible_devices: str = _GPU
    device: str = _DEVICE


Settings = OfflineOcrSettings


def load_settings(environ: Mapping[str, str] | None = None) -> OfflineOcrSettings:
    values = os.environ if environ is None else environ
    cuda_visible_devices = values.get("CUDA_VISIBLE_DEVICES")
    if cuda_visible_devices != _GPU:
        raise ValueError("CUDA_VISIBLE_DEVICES must be exactly '5'.")

    host = values.get("OCR_HOST", DEFAULT_HOST)
    if host != DEFAULT_HOST:
        raise ValueError("OCR worker host must be loopback 127.0.0.1.")
    port = _bounded_port(values.get("OCR_PORT", str(DEFAULT_PORT)))

    model = values.get("OCR_MODEL", OCR_MODEL)
    revision = values.get("OCR_MODEL_REVISION", OCR_REVISION)
    if model != OCR_MODEL:
        raise ValueError("OCR model is not pinned.")
    if revision != OCR_REVISION:
        raise ValueError("OCR model revision is not pinned.")

    model_path = _required_directory(values.get("OCR_MODEL_PATH"), "model directory")
    manifest_path = model_path / "model-manifest.json"
    _validate_manifest(manifest_path, model_path, model, revision)

    temp_dir = _required_directory(
        values.get("OCR_TEMP_DIR", str(Path.home() / "resume-ai" / "tmp")),
        "temporary directory",
    )
    token_path = _required_file(values.get("OCR_API_TOKEN_FILE"), "token file")
    if not _has_secure_token_permissions(token_path):
        raise ValueError("OCR API token file must have mode 0600.")
    api_token = token_path.read_text(encoding="utf-8").strip()
    if not api_token:
        raise ValueError("OCR API token file must not be empty.")

    return OfflineOcrSettings(
        api_token=api_token,
        model_path=model_path,
        manifest_path=manifest_path,
        temp_dir=temp_dir,
        cuda_visible_devices=cuda_visible_devices,
        device=_DEVICE,
        host=host,
        port=port,
        model=model,
        revision=revision,
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


def _bounded_port(raw_value: str) -> int:
    try:
        port = int(raw_value)
    except (TypeError, ValueError) as error:
        raise ValueError("port must be an integer.") from error
    if port != DEFAULT_PORT:
        raise ValueError(f"OCR worker port must be {DEFAULT_PORT}.")
    return port


def _has_secure_token_permissions(path: Path) -> bool:
    if os.name != "nt":
        return stat.S_IMODE(path.stat().st_mode) == 0o600

    try:
        result = subprocess.run(["icacls", str(path)], check=False, capture_output=True, text=True)
    except OSError:
        return False
    if result.returncode != 0:
        return False
    username = os.environ.get("USERNAME", "")
    if not username:
        return False
    current_user_has_access = False
    for line in (line.strip() for line in result.stdout.splitlines() if line.strip()):
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


def _validate_manifest(manifest_path: Path, model_path: Path, model: str, revision: str) -> None:
    if not manifest_path.is_file():
        raise ValueError("model-manifest.json is required.")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("model-manifest.json is invalid.") from error
    if not isinstance(manifest, dict):
        raise ValueError("model-manifest.json must contain an object.")
    if manifest.get("verificationStatus") != "verified":
        raise ValueError("model-manifest.json is not verified for deployment.")
    if manifest.get("model") != model or manifest.get("revision") != revision:
        raise ValueError("model-manifest.json identity does not match pinned settings.")

    files = manifest.get("files")
    custom_code_files = manifest.get("customCodeFiles")
    if not isinstance(files, list) or not files:
        raise ValueError("model-manifest.json must list at least one model file.")
    if not isinstance(custom_code_files, list) or not custom_code_files:
        raise ValueError("model-manifest.json must list reviewed custom code files.")

    listed_files: set[Path] = set()
    for item in files:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            raise ValueError("model-manifest.json contains an invalid file entry.")
        relative_path = Path(item["path"])
        if relative_path.is_absolute() or ".." in relative_path.parts or relative_path in listed_files:
            raise ValueError("model-manifest.json contains an unsafe or duplicate file path.")
        listed_files.add(relative_path)
        expected_hash = item.get("sha256")
        if not isinstance(expected_hash, str) or not _SHA256.fullmatch(expected_hash):
            raise ValueError("model-manifest.json contains an invalid hash.")
        file_path = model_path / relative_path
        if file_path.is_symlink() or not file_path.is_file():
            raise ValueError("model-manifest.json references a missing or unsafe file.")
        actual_hash = hashlib.sha256(file_path.read_bytes()).hexdigest()
        if not hmac.compare_digest(actual_hash, expected_hash.lower()):
            raise ValueError("model-manifest.json file hash does not match.")

    custom_paths = {Path(path) for path in custom_code_files if isinstance(path, str)}
    if len(custom_paths) != len(custom_code_files) or not custom_paths <= listed_files:
        raise ValueError("model-manifest.json custom code coverage is invalid.")
    if any(path.suffix != ".py" for path in custom_paths):
        raise ValueError("model-manifest.json custom code entries must be Python files.")

    actual_files = set()
    for file_path in model_path.rglob("*"):
        if not file_path.is_file() or file_path.resolve() == manifest_path.resolve():
            continue
        if file_path.is_symlink():
            raise ValueError("model directory contains an unsafe symlink.")
        actual_files.add(file_path.relative_to(model_path))
    if listed_files != actual_files:
        raise ValueError("model-manifest.json does not cover all model files.")
