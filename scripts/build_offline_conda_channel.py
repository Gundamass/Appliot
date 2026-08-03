#!/usr/bin/env python3
"""Build a verified linux-64/noarch Conda channel from dry-run plans."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Mapping
from urllib.parse import urlparse


SHA256 = re.compile(r"^[0-9a-f]{64}$")
ALLOWED_HOSTS = {"repo.anaconda.com"}
SUBDIRS = ("linux-64", "noarch")


class BuildError(ValueError):
    """Raised when a Conda plan or downloaded package is unsafe."""


def build_channel(
    plans: Iterable[Mapping[str, Any]],
    output: Path,
    *,
    download: Callable[[str, Path], None] | None = None,
) -> None:
    fetch = download or _download
    records: Dict[str, Dict[str, Dict[str, Any]]] = {subdir: {} for subdir in SUBDIRS}
    for plan in plans:
        if plan.get("success") is not True:
            raise BuildError("Conda dry-run plan was unsuccessful")
        actions = plan.get("actions")
        items = actions.get("FETCH") if isinstance(actions, dict) else None
        if not isinstance(items, list):
            raise BuildError("Conda dry-run plan has no fetch closure")
        for raw in items:
            record = _normalize_record(raw)
            subdir = record["_subdir"]
            filename = record["_filename"]
            existing = records[subdir].get(filename)
            if existing is not None:
                if existing != record:
                    raise BuildError("Conda plans contain conflicting package records")
                continue
            records[subdir][filename] = record

    output.mkdir(parents=True, exist_ok=True)
    for subdir in SUBDIRS:
        directory = output / subdir
        directory.mkdir(parents=True, exist_ok=True)
        repodata_records: Dict[str, Dict[str, Any]] = {}
        for filename, stored in sorted(records[subdir].items()):
            record = dict(stored)
            url = record.pop("_url")
            record.pop("_subdir")
            record.pop("_filename")
            destination = directory / filename
            temporary = directory / ("." + filename + ".partial")
            try:
                if temporary.exists():
                    temporary.unlink()
                fetch(url, temporary)
                _verify_download(temporary, record)
                os.replace(str(temporary), str(destination))
            except Exception as error:
                if temporary.exists():
                    temporary.unlink()
                if isinstance(error, BuildError):
                    raise
                raise BuildError("Conda package download failed") from error
            repodata_records[filename] = record
        repodata = {
            "info": {"subdir": subdir},
            "packages": {},
            "packages.conda": repodata_records,
        }
        encoded = json.dumps(repodata, sort_keys=True, separators=(",", ":")) + "\n"
        (directory / "repodata.json").write_text(encoded, encoding="utf-8")
        (directory / "current_repodata.json").write_text(encoded, encoding="utf-8")


def _normalize_record(raw: Any) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise BuildError("Conda package record is invalid")
    url = raw.get("url")
    filename = raw.get("fn")
    subdir = raw.get("subdir")
    digest = raw.get("sha256")
    size = raw.get("size")
    if not isinstance(url, str) or not isinstance(filename, str) or subdir not in SUBDIRS:
        raise BuildError("Conda package location is invalid")
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise BuildError("Conda package download host is not approved")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise BuildError("Conda package URL is unsafe")
    if Path(parsed.path).name != filename or Path(filename).name != filename:
        raise BuildError("Conda package filename is unsafe")
    if not isinstance(digest, str) or SHA256.fullmatch(digest) is None:
        raise BuildError("Conda package hash is invalid")
    if not isinstance(size, int) or size < 1:
        raise BuildError("Conda package size is invalid")
    required = ("name", "version", "build", "build_number", "depends")
    if any(key not in raw for key in required) or not isinstance(raw["depends"], list):
        raise BuildError("Conda package metadata is incomplete")
    record = {
        key: raw[key]
        for key in (
            "name", "version", "build", "build_number", "depends", "constrains",
            "license", "license_family", "md5", "sha256", "size", "timestamp",
        )
        if key in raw
    }
    record["subdir"] = subdir
    record["_subdir"] = subdir
    record["_filename"] = filename
    record["_url"] = url
    return record


def _verify_download(path: Path, record: Mapping[str, Any]) -> None:
    if not path.is_file() or path.is_symlink():
        raise BuildError("Downloaded Conda package is unsafe")
    if path.stat().st_size != record["size"]:
        raise BuildError("Downloaded Conda package size mismatch")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != record["sha256"]:
        raise BuildError("Downloaded Conda package hash mismatch")


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "ApplyPilot-offline-builder/1"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("xb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", action="append", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    plans = [json.loads(path.read_text(encoding="utf-8-sig")) for path in arguments.plan]
    build_channel(plans, arguments.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
