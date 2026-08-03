#!/usr/bin/env python3
"""Generate an exact SHA-256 manifest for an offline asset directory."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from typing import Any, Dict


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_fields(path: Path) -> Dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict) or "files" in value:
        raise ValueError("fields must be a JSON object without files")
    return value


def generate_manifest(root: Path, manifest_name: str, fields: Dict[str, Any]) -> Path:
    root = root.resolve(strict=True)
    if (
        manifest_name in ("", ".", "..")
        or "/" in manifest_name
        or "\\" in manifest_name
        or Path(manifest_name).name != manifest_name
    ):
        raise ValueError("manifest name must be a single safe filename")
    manifest_path = root / manifest_name
    files = []
    for current_root, directory_names, names in os.walk(root, followlinks=False):
        current = Path(current_root)
        for name in [*directory_names, *names]:
            item = current / name
            if item.is_symlink():
                raise ValueError(f"asset directory contains a symlink: {item}")
        for name in names:
            path = current / name
            if path == manifest_path:
                continue
            if not path.is_file():
                raise ValueError(f"asset directory contains a non-regular file: {path}")
            files.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "sha256": _sha256(path),
                }
            )
    files.sort(key=lambda entry: entry["path"])
    value = dict(fields)
    value["files"] = files
    temporary = manifest_path.with_name(manifest_path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(manifest_path)
    return manifest_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--name", required=True)
    fields_group = parser.add_mutually_exclusive_group(required=True)
    fields_group.add_argument("--fields", help="JSON object excluding files")
    fields_group.add_argument("--fields-file", type=Path, help="JSON file containing fields")
    arguments = parser.parse_args()
    try:
        fields = read_fields(arguments.fields_file) if arguments.fields_file else json.loads(arguments.fields)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        parser.error(str(error))
    if not isinstance(fields, dict) or "files" in fields:
        parser.error("fields must be a JSON object without files")
    generate_manifest(arguments.root, arguments.name, fields)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
