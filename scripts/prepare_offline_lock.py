#!/usr/bin/env python3
"""Turn a generated hashed requirements file into an offline install lock."""

from __future__ import annotations

import argparse
from pathlib import Path


FORBIDDEN_DIRECTIVES = ("--index-url", "--extra-index-url", "--find-links")


class LockError(ValueError):
    """Raised when a generated lock can reach an external package source."""


def prepare_lock(source: Path, target: Path) -> None:
    text = source.read_text(encoding="utf-8")
    lines = text.splitlines()
    for line in lines:
        if line.strip().startswith(FORBIDDEN_DIRECTIVES):
            raise LockError("requirements lock contains an index or link directive")

    if "--require-hashes" not in {line.strip() for line in lines}:
        insertion = 0
        while insertion < len(lines) and lines[insertion].lstrip().startswith("#"):
            insertion += 1
        lines.insert(insertion, "--require-hashes")

    result = "\n".join(lines) + ("\n" if text.endswith(("\n", "\r")) else "")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(result, encoding="utf-8", newline="\n")
    temporary.replace(target)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    arguments = parser.parse_args()
    prepare_lock(arguments.source, arguments.target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
