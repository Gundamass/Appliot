#!/usr/bin/env python3
"""Verify every deployable remote Worker and model asset before installation."""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Dict, List, Optional, Set, Tuple, Union


SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
PINNED_REQUIREMENT = re.compile(r"^[A-Za-z0-9_.-]+(?:\[[^\]]+\])?==[^\s\\]+")
BLOCKER_MARKERS = ("external acceptance blocker", "template_unverified", "replace every entry")

WORKERS = (
    {
        "directory": "embedding-worker",
        "worker": "resume-embedding-worker",
        "python": "3.10",
    },
    {
        "directory": "ocr-worker",
        "worker": "resume-ocr-worker",
        "python": "3.12",
    },
)

MODELS = (
    {
        "directory": "Qwen3-Embedding-8B",
        "model": "Qwen/Qwen3-Embedding-8B",
        "revision": "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af",
        "dimensions": 4096,
    },
    {
        "directory": "DeepSeek-OCR-2",
        "model": "deepseek-ai/DeepSeek-OCR-2",
        "revision": "aaa02f3811945a91062062994c5c4a3f4c0af2b0",
        "requires_review": True,
    },
)


class VerificationError(ValueError):
    """Raised when an offline deployment asset cannot be trusted."""


def verify_bundle(bundle: Union[Path, str]) -> str:
    bundle_root = _safe_root(Path(bundle), "bundle")
    _assert_exact_children(
        bundle_root,
        {"conda-channel", "models", "workers"},
        set(),
        "bundle structure",
    )
    _verify_conda_channel(bundle_root / "conda-channel")
    _assert_exact_children(
        bundle_root / "workers",
        {item["directory"] for item in WORKERS},
        set(),
        "workers structure",
    )
    _assert_exact_children(
        bundle_root / "models",
        {item["directory"] for item in MODELS},
        set(),
        "models structure",
    )

    for expected in WORKERS:
        root = _safe_root(bundle_root / "workers" / expected["directory"], "Worker directory")
        _assert_exact_children(
            root,
            {"wheelhouse"},
            {"requirements.lock", "worker-manifest.json"},
            "Worker structure",
        )
        manifest_path = root / "worker-manifest.json"
        manifest = _read_manifest(manifest_path)
        _assert_manifest_keys(
            manifest_path,
            manifest,
            {"verificationStatus", "worker", "python", "wheel", "files"},
        )
        if (
            manifest.get("worker") != expected["worker"]
            or manifest.get("python") != expected["python"]
        ):
            raise VerificationError(f"{manifest_path}: Worker identity or Python version is not pinned")
        verified = _verify_file_manifest(root, manifest_path, manifest)

        wheel = _manifest_relative_path(manifest.get("wheel"), manifest_path, "wheel")
        if wheel not in verified or wheel.parts[0] != "wheelhouse" or wheel.suffix != ".whl":
            raise VerificationError(f"{manifest_path}: wheel must name a verified wheelhouse file")
        lock_path = root / "requirements.lock"
        if PurePosixPath("requirements.lock") not in verified:
            raise VerificationError(f"{manifest_path}: requirements.lock is not covered")
        _verify_requirement_lock(lock_path)

    for expected in MODELS:
        root = _safe_root(bundle_root / "models" / expected["directory"], "model directory")
        manifest_path = root / "model-manifest.json"
        manifest = _read_manifest(manifest_path)
        required_keys = {"verificationStatus", "model", "revision", "files"}
        if "dimensions" in expected:
            required_keys.add("dimensions")
        if expected.get("requires_review"):
            required_keys.add("customCodeFiles")
        _assert_manifest_keys(manifest_path, manifest, required_keys)
        if manifest.get("model") != expected["model"] or manifest.get("revision") != expected["revision"]:
            raise VerificationError(f"{manifest_path}: model identity or revision is not pinned")
        if "dimensions" in expected and manifest.get("dimensions") != expected["dimensions"]:
            raise VerificationError(f"{manifest_path}: embedding dimensions are not pinned")
        verified = _verify_file_manifest(root, manifest_path, manifest)
        if expected.get("requires_review"):
            _verify_custom_code_review(manifest_path, manifest, verified)
    return _fingerprint_closure(bundle_root)


def _verify_conda_channel(channel: Path) -> None:
    root = _safe_root(channel, "Conda channel")
    _assert_exact_children(root, {"linux-64", "noarch"}, set(), "Conda channel structure")
    for subdir in ("linux-64", "noarch"):
        directory = _safe_root(root / subdir, "Conda channel subdirectory")
        indexes: List[Dict[str, Any]] = []
        repodata_path = directory / "repodata.json"
        current_path = directory / "current_repodata.json"
        for path in (repodata_path, current_path):
            value = _read_json_object(path, "Conda repodata")
            info = value.get("info")
            if not isinstance(info, dict) or info.get("subdir") != subdir:
                raise VerificationError(f"{path}: Conda repodata subdir is invalid")
            records: Dict[str, Any] = {}
            for key in ("packages", "packages.conda"):
                entries = value.get(key, {})
                if not isinstance(entries, dict):
                    raise VerificationError(f"{path}: Conda repodata packages are invalid")
                records.update(entries)
            for filename, record in records.items():
                if not isinstance(filename, str) or not isinstance(record, dict):
                    raise VerificationError(f"{path}: Conda repodata record is invalid")
                if (
                    filename in ("", ".", "..")
                    or "/" in filename
                    or "\\" in filename
                    or Path(filename).name != filename
                ):
                    raise VerificationError(f"{path}: Conda package filename is unsafe")
                expected_hash = record.get("sha256")
                expected_size = record.get("size")
                if not isinstance(expected_hash, str) or SHA256.fullmatch(expected_hash) is None:
                    raise VerificationError(f"{path}: Conda package hash is invalid")
                if not isinstance(expected_size, int) or expected_size < 1:
                    raise VerificationError(f"{path}: Conda package size is invalid")
            indexes.append(records)
        if indexes[0] != indexes[1]:
            raise VerificationError(f"{directory}: Conda repodata indexes are inconsistent")
        referenced = set(indexes[0])
        for filename, record in indexes[0].items():
                package = directory / filename
                if not package.is_file() or package.is_symlink():
                    raise VerificationError(f"{package}: Conda package is missing or unsafe")
                expected_hash = record["sha256"]
                expected_size = record["size"]
                if package.stat().st_size != expected_size:
                    raise VerificationError(f"{package}: Conda package size mismatch")
                actual_hash = _sha256_file(package)
                if not hmac.compare_digest(actual_hash.lower(), expected_hash.lower()):
                    raise VerificationError(f"{package}: Conda package hash mismatch")
        allowed = referenced | {"repodata.json", "current_repodata.json"}
        children = list(directory.iterdir())
        if any(child.is_symlink() or not child.is_file() for child in children):
            raise VerificationError(f"{directory}: Conda channel contains an unsafe entry")
        if {child.name for child in children} != allowed:
            raise VerificationError(f"{directory}: Conda channel contains unreferenced files")


def _read_json_object(path: Path, label: str) -> Dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise VerificationError(f"{path}: {label} is missing or unsafe")
    def reject_duplicates(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
        value: Dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise VerificationError(f"{path}: duplicate JSON field {key}")
            value[key] = item
        return value
    try:
        value = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicates)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise VerificationError(f"{path}: {label} is invalid") from error
    if not isinstance(value, dict):
        raise VerificationError(f"{path}: {label} must contain an object")
    return value


def _safe_root(path: Path, label: str) -> Path:
    if path.is_symlink():
        raise VerificationError(f"{path}: {label} must not be a symlink")
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise VerificationError(f"{path}: {label} does not exist") from error
    if not resolved.is_dir():
        raise VerificationError(f"{path}: {label} is not a directory")
    return resolved


def _read_manifest(path: Path) -> Dict[str, Any]:
    if path.is_symlink():
        raise VerificationError(f"{path}: manifest must not be a symlink")

    def reject_duplicate_fields(pairs: List[Tuple[str, Any]]) -> Dict[str, Any]:
        value: Dict[str, Any] = {}
        for key, item in pairs:
            if key in value:
                raise VerificationError(f"{path}: duplicate JSON field {key}")
            value[key] = item
        return value

    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=reject_duplicate_fields,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise VerificationError(f"{path}: manifest is missing or invalid") from error
    if not isinstance(value, dict):
        raise VerificationError(f"{path}: manifest must contain an object")
    if value.get("verificationStatus") != "verified":
        raise VerificationError(f"{path}: manifest is not verified")
    return value


def _assert_manifest_keys(path: Path, manifest: Dict[str, Any], expected: Set[str]) -> None:
    if set(manifest) != expected:
        raise VerificationError(f"{path}: manifest fields do not match the deployment schema")


def _assert_exact_children(
    root: Path,
    expected_directories: Set[str],
    expected_files: Set[str],
    label: str,
) -> None:
    actual_directories: Set[str] = set()
    actual_files: Set[str] = set()
    try:
        children = list(root.iterdir())
    except OSError as error:
        raise VerificationError(f"{root}: {label} cannot be inspected") from error
    for child in children:
        if child.is_symlink():
            raise VerificationError(f"{root}: {label} contains a symlink")
        if child.is_dir():
            actual_directories.add(child.name)
        elif child.is_file():
            actual_files.add(child.name)
        else:
            raise VerificationError(f"{root}: {label} contains a non-regular entry")
    if actual_directories != expected_directories or actual_files != expected_files:
        raise VerificationError(f"{root}: {label} is not exact")


def _verify_file_manifest(
    root: Path,
    manifest_path: Path,
    manifest: Dict[str, Any],
) -> Dict[PurePosixPath, str]:
    entries = manifest.get("files")
    if not isinstance(entries, list) or not entries:
        raise VerificationError(f"{manifest_path}: files must be a non-empty list")

    verified: Dict[PurePosixPath, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise VerificationError(f"{manifest_path}: invalid file entry")
        relative = _manifest_relative_path(entry.get("path"), manifest_path, "file path")
        if relative in verified:
            raise VerificationError(f"{manifest_path}: duplicate path {relative.as_posix()}")
        expected_hash = entry.get("sha256")
        if not isinstance(expected_hash, str) or not SHA256.fullmatch(expected_hash):
            raise VerificationError(f"{manifest_path}: invalid SHA-256 for {relative.as_posix()}")
        file_path = root.joinpath(*relative.parts)
        _reject_symlink_components(root, relative, manifest_path)
        try:
            resolved_file = file_path.resolve(strict=True)
            resolved_file.relative_to(root)
        except (OSError, RuntimeError, ValueError) as error:
            raise VerificationError(
                f"{manifest_path}: missing or unsafe file {relative.as_posix()}"
            ) from error
        if not resolved_file.is_file():
            raise VerificationError(f"{manifest_path}: {relative.as_posix()} is not a regular file")
        actual_hash = _sha256_file(resolved_file)
        if not hmac.compare_digest(actual_hash, expected_hash.lower()):
            raise VerificationError(f"{manifest_path}: hash mismatch for {relative.as_posix()}")
        verified[relative] = actual_hash

    actual_files, actual_directories = _regular_entries(root, manifest_path)
    if set(verified) != actual_files:
        missing = sorted(path.as_posix() for path in actual_files - set(verified))
        stale = sorted(path.as_posix() for path in set(verified) - actual_files)
        detail = f" unlisted={missing} missing={stale}"
        raise VerificationError(f"{manifest_path}: manifest does not exactly cover its directory;{detail}")
    expected_directories = {
        PurePosixPath(*path.parts[:index])
        for path in verified
        for index in range(1, len(path.parts))
    }
    if actual_directories != expected_directories:
        raise VerificationError(f"{manifest_path}: directory closure does not match manifested files")
    return verified


def _manifest_relative_path(value: object, manifest_path: Path, label: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise VerificationError(f"{manifest_path}: {label} is an unsafe path")
    path = PurePosixPath(value)
    windows_path = PureWindowsPath(value)
    if (
        path.is_absolute()
        or bool(windows_path.drive)
        or path.as_posix() != value
        or any(part in ("", ".", "..") for part in path.parts)
    ):
        raise VerificationError(f"{manifest_path}: {label} is an unsafe path")
    return path


def _reject_symlink_components(root: Path, relative: PurePosixPath, manifest_path: Path) -> None:
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise VerificationError(f"{manifest_path}: file path contains a symlink: {relative.as_posix()}")


def _regular_entries(root: Path, manifest_path: Path) -> Tuple[Set[PurePosixPath], Set[PurePosixPath]]:
    files: Set[PurePosixPath] = set()
    directory_paths: Set[PurePosixPath] = set()

    def on_error(error: OSError) -> None:
        raise error

    try:
        for current_root, directory_names, names in os.walk(root, followlinks=False, onerror=on_error):
            current = Path(current_root)
            for name in [*directory_names, *names]:
                item = current / name
                if item.is_symlink():
                    raise VerificationError(f"{manifest_path}: directory contains a symlink")
            for name in names:
                item = current / name
                if not item.is_file():
                    raise VerificationError(f"{manifest_path}: directory contains a non-regular file")
                if item != manifest_path:
                    files.add(PurePosixPath(item.relative_to(root).as_posix()))
            for name in directory_names:
                item = current / name
                directory_paths.add(PurePosixPath(item.relative_to(root).as_posix()))
    except OSError as error:
        raise VerificationError(f"{manifest_path}: directory could not be inspected safely") from error
    return files, directory_paths


def _verify_requirement_lock(path: Path) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise VerificationError(f"{path}: requirements lock cannot be read") from error
    lowered = text.lower()
    if any(marker in lowered for marker in BLOCKER_MARKERS):
        raise VerificationError(f"{path}: requirements lock is a template or blocker")
    if not any(line.strip() == "--require-hashes" for line in text.splitlines()):
        raise VerificationError(f"{path}: requirements lock must enable --require-hashes")
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line.startswith("--") and line != "--require-hashes" and not line.startswith("--hash=sha256:"):
            raise VerificationError(f"{path}: requirements lock contains an unsupported option")

    requirements = _logical_requirements(text)
    if not requirements:
        raise VerificationError(f"{path}: requirements lock is empty")
    for requirement in requirements:
        if not PINNED_REQUIREMENT.match(requirement) or "--hash=sha256:" not in requirement:
            raise VerificationError(f"{path}: every requirement must be pinned and hash-locked")
        hashes = re.findall(r"--hash=sha256:([0-9a-fA-F]{64})(?:\s|$)", requirement)
        if not hashes:
            raise VerificationError(f"{path}: every requirement must be pinned and hash-locked")


def _logical_requirements(text: str) -> List[str]:
    requirements: List[str] = []
    current = ""
    for raw_line in text.splitlines():
        line = raw_line.split(" #", 1)[0].strip()
        if not line or line.startswith("#"):
            continue
        if current:
            current = f"{current} {line}"
        else:
            current = line
        if current.endswith("\\"):
            current = current[:-1].rstrip()
            continue
        if not current.startswith("--"):
            requirements.append(current)
        current = ""
    if current:
        requirements.append(current)
    return requirements


def _verify_custom_code_review(
    manifest_path: Path,
    manifest: Dict[str, Any],
    verified: Dict[PurePosixPath, str],
) -> None:
    if manifest.get("verificationStatus") != "verified":
        raise VerificationError(f"{manifest_path}: OCR model manifest is not verified")
    raw_custom_paths = manifest.get("customCodeFiles")
    if not isinstance(raw_custom_paths, list) or not raw_custom_paths:
        raise VerificationError(f"{manifest_path}: reviewed customCodeFiles must be non-empty")
    custom_paths: Set[PurePosixPath] = set()
    for value in raw_custom_paths:
        path = _manifest_relative_path(value, manifest_path, "custom code path")
        if path in custom_paths:
            raise VerificationError(f"{manifest_path}: duplicate custom code path")
        custom_paths.add(path)
    python_paths = {path for path in verified if path.suffix == ".py"}
    if custom_paths != python_paths:
        raise VerificationError(f"{manifest_path}: customCodeFiles does not cover every Python file")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fingerprint_closure(root: Path) -> str:
    fingerprint = hashlib.sha256()
    entries: List[Tuple[str, PurePosixPath, Optional[Path]]] = []
    for current_root, directory_names, file_names in os.walk(root, followlinks=False):
        current = Path(current_root)
        for name in directory_names:
            path = current / name
            entries.append(("D", PurePosixPath(path.relative_to(root).as_posix()), None))
        for name in file_names:
            path = current / name
            entries.append(("F", PurePosixPath(path.relative_to(root).as_posix()), path))
    for kind, relative, file_path in sorted(entries, key=lambda item: (item[1].as_posix(), item[0])):
        fingerprint.update(kind.encode("ascii") + b"\0")
        fingerprint.update(relative.as_posix().encode("utf-8") + b"\0")
        if file_path is not None:
            fingerprint.update(_sha256_file(file_path).encode("ascii"))
        fingerprint.update(b"\0")
    return fingerprint.hexdigest()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, type=Path)
    arguments = parser.parse_args(argv)
    try:
        print(verify_bundle(arguments.bundle))
    except VerificationError as error:
        print(f"asset verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
