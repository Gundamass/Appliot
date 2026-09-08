import hashlib
import hmac
import json
import os
import re
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, cast

from .types import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    OCR_MODEL,
    OCR_REVISION,
    OCR_RUNTIMES,
    OcrRuntime,
    WorkerSettings,
)


_GPU = "5"
_DEVICE = "cuda:0"
_ASCEND_DEVICE = "ascend:0"
_SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
_ASCEND_DEVICE_PATTERN = re.compile(r"^ascend:[0-9]+$")
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
    runtime_value = values.get("OCR_RUNTIME", "pytorch").strip().lower()
    if runtime_value not in OCR_RUNTIMES:
        raise ValueError("OCR_RUNTIME must be one of: pytorch, mindspore_lite.")
    runtime = cast(OcrRuntime, runtime_value)

    cuda_visible_devices = values.get("CUDA_VISIBLE_DEVICES", "")
    if runtime == "pytorch" and cuda_visible_devices != _GPU:
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
    if runtime == "pytorch":
        _validate_manifest(manifest_path, model_path, model, revision)
        device = _DEVICE
    else:
        _validate_mindspore_manifest(manifest_path, model_path, model, revision)
        device = values.get("OCR_DEVICE", _ASCEND_DEVICE)
        if not _ASCEND_DEVICE_PATTERN.fullmatch(device):
            raise ValueError("OCR_DEVICE must be an Ascend device such as 'ascend:0'.")

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
        device=device,
        host=host,
        port=port,
        model=model,
        revision=revision,
        runtime=runtime,
    )


def _required_directory(raw_path: str | None, label: str) -> Path:
    if not raw_path:
        raise ValueError(f"{label} is required.")
    path = Path(raw_path).expanduser()
    if path.is_symlink():
        raise ValueError(f"{label} must not be a symlink.")
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
    model_root = model_path.resolve(strict=True)
    if manifest_path.is_symlink():
        raise ValueError("model-manifest.json must not be a symlink.")
    if not manifest_path.is_file():
        raise ValueError("model-manifest.json is required.")
    try:
        resolved_manifest_path = manifest_path.resolve(strict=True)
        resolved_manifest_path.relative_to(model_root)
    except (OSError, RuntimeError, ValueError) as error:
        raise ValueError("model-manifest.json resolves outside the model directory.") from error

    snapshot_entries = _snapshot_entries(model_root)
    try:
        manifest = json.loads(resolved_manifest_path.read_text(encoding="utf-8"))
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
        file_path = model_root / relative_path
        if _has_symlink_component(model_root, relative_path):
            raise ValueError("model-manifest.json file path contains a symlink.")
        try:
            resolved_file_path = file_path.resolve(strict=True)
            resolved_file_path.relative_to(model_root)
        except (OSError, RuntimeError) as error:
            raise ValueError("model-manifest.json references a missing file.") from error
        except ValueError as error:
            raise ValueError("model-manifest.json file resolves outside the model directory.") from error
        if not resolved_file_path.is_file():
            raise ValueError("model-manifest.json references a missing or unsafe file.")
        actual_hash = hashlib.sha256(resolved_file_path.read_bytes()).hexdigest()
        if not hmac.compare_digest(actual_hash, expected_hash.lower()):
            raise ValueError("model-manifest.json file hash does not match.")

    actual_files = {
        path.relative_to(model_root)
        for path in snapshot_entries
        if path.is_file() and path != resolved_manifest_path
    }
    if listed_files != actual_files:
        raise ValueError("model-manifest.json does not cover all model files.")

    custom_paths = set()
    for raw_path in custom_code_files:
        if not isinstance(raw_path, str):
            raise ValueError("model-manifest.json custom code coverage is invalid.")
        custom_path = Path(raw_path)
        if custom_path.is_absolute() or ".." in custom_path.parts or custom_path in custom_paths:
            raise ValueError("model-manifest.json custom code coverage is invalid.")
        custom_paths.add(custom_path)
    if not custom_paths <= listed_files:
        raise ValueError("model-manifest.json custom code coverage is invalid.")
    if any(path.suffix != ".py" for path in custom_paths):
        raise ValueError("model-manifest.json custom code entries must be Python files.")
    python_files = {path for path in actual_files if path.suffix == ".py"}
    if custom_paths != python_files:
        raise ValueError("model-manifest.json custom code coverage is incomplete.")


def _validate_mindspore_manifest(manifest_path: Path, model_path: Path, model: str, revision: str) -> None:
    model_root, resolved_manifest_path, manifest = _read_manifest_document(
        manifest_path,
        model_path,
        model,
        revision,
    )
    if manifest.get("verificationStatus") != "verified":
        raise ValueError("model-manifest.json is not verified for MindSpore Lite deployment.")
    if manifest.get("runtime") != "mindspore_lite":
        raise ValueError("model-manifest.json runtime identity does not match MindSpore Lite.")

    components = manifest.get("components")
    if not isinstance(components, dict):
        raise ValueError("model-manifest.json must declare MindSpore Lite components.")
    component_names = ("detector", "recognizer", "vocabulary", "preprocessingVersion")
    if any(not isinstance(components.get(name), str) or not components[name].strip() for name in component_names):
        raise ValueError("model-manifest.json MindSpore Lite components are incomplete.")
    if Path(components["detector"]).suffix.lower() != ".mindir":
        raise ValueError("model-manifest.json detector must be a .mindir file.")
    if Path(components["recognizer"]).suffix.lower() != ".mindir":
        raise ValueError("model-manifest.json recognizer must be a .mindir file.")
    if Path(components["vocabulary"]).suffix.lower() not in {".txt", ".json"}:
        raise ValueError("model-manifest.json vocabulary must be a text or JSON file.")

    custom_code_files = manifest.get("customCodeFiles")
    if custom_code_files != []:
        raise ValueError("model-manifest.json MindSpore Lite packages must not contain custom code.")

    listed_files, actual_files = _validate_manifest_file_inventory(
        manifest,
        model_root,
        resolved_manifest_path,
    )
    if listed_files != actual_files:
        raise ValueError("model-manifest.json does not cover all model files.")

    for component_name in ("detector", "recognizer", "vocabulary"):
        relative_path = Path(components[component_name])
        if (
            relative_path.is_absolute()
            or ".." in relative_path.parts
            or relative_path not in listed_files
            or _has_symlink_component(model_root, relative_path)
        ):
            raise ValueError("model-manifest.json contains an unsafe component path.")


def _read_manifest_document(
    manifest_path: Path,
    model_path: Path,
    model: str,
    revision: str,
) -> tuple[Path, Path, dict[str, object]]:
    model_root = model_path.resolve(strict=True)
    if manifest_path.is_symlink():
        raise ValueError("model-manifest.json must not be a symlink.")
    if not manifest_path.is_file():
        raise ValueError("model-manifest.json is required.")
    try:
        resolved_manifest_path = manifest_path.resolve(strict=True)
        resolved_manifest_path.relative_to(model_root)
    except (OSError, RuntimeError, ValueError) as error:
        raise ValueError("model-manifest.json resolves outside the model directory.") from error
    try:
        manifest = json.loads(resolved_manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("model-manifest.json is invalid.") from error
    if not isinstance(manifest, dict):
        raise ValueError("model-manifest.json must contain an object.")
    if manifest.get("model") != model or manifest.get("revision") != revision:
        raise ValueError("model-manifest.json identity does not match pinned settings.")
    return model_root, resolved_manifest_path, manifest


def _validate_manifest_file_inventory(
    manifest: dict[str, object],
    model_root: Path,
    resolved_manifest_path: Path,
) -> tuple[set[Path], set[Path]]:
    snapshot_entries = _snapshot_entries(model_root)
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("model-manifest.json must list at least one model file.")

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
        file_path = model_root / relative_path
        if _has_symlink_component(model_root, relative_path):
            raise ValueError("model-manifest.json file path contains a symlink.")
        try:
            resolved_file_path = file_path.resolve(strict=True)
            resolved_file_path.relative_to(model_root)
        except (OSError, RuntimeError) as error:
            raise ValueError("model-manifest.json references a missing file.") from error
        except ValueError as error:
            raise ValueError("model-manifest.json file resolves outside the model directory.") from error
        if not resolved_file_path.is_file():
            raise ValueError("model-manifest.json references a missing or unsafe file.")
        actual_hash = hashlib.sha256(resolved_file_path.read_bytes()).hexdigest()
        if not hmac.compare_digest(actual_hash, expected_hash.lower()):
            raise ValueError("model-manifest.json file hash does not match.")

    actual_files = {
        path.relative_to(model_root)
        for path in snapshot_entries
        if path.is_file() and path != resolved_manifest_path
    }
    return listed_files, actual_files


def _snapshot_entries(model_root: Path) -> list[Path]:
    entries: list[Path] = []

    def raise_walk_error(error: OSError) -> None:
        raise error

    try:
        for current_root, directory_names, file_names in os.walk(
            model_root,
            followlinks=False,
            onerror=raise_walk_error,
        ):
            root = Path(current_root)
            for name in [*directory_names, *file_names]:
                entry = root / name
                if entry.is_symlink():
                    raise ValueError("model directory contains an unsafe symlink.")
                entries.append(entry)
    except OSError as error:
        raise ValueError("model directory could not be inspected safely.") from error
    return entries


def _has_symlink_component(model_root: Path, relative_path: Path) -> bool:
    return any(
        model_root.joinpath(*relative_path.parts[:index]).is_symlink()
        for index in range(1, len(relative_path.parts) + 1)
    )
