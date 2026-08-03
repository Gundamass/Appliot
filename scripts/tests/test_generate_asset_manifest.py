from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.generate_asset_manifest import generate_manifest, read_fields


class GenerateAssetManifestTests(unittest.TestCase):
    def test_reads_fields_from_json_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fields.json"
            path.write_text('{"worker":"resume-worker"}', encoding="utf-8")

            self.assertEqual(read_fields(path), {"worker": "resume-worker"})

    def test_reads_utf8_bom_fields_from_windows_powershell(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fields.json"
            path.write_bytes(b"\xef\xbb\xbf" + b'{"worker":"resume-worker"}')

            self.assertEqual(read_fields(path), {"worker": "resume-worker"})

    def test_covers_files_with_sorted_posix_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "wheelhouse").mkdir()
            (root / "requirements.lock").write_bytes(b"lock")
            (root / "wheelhouse" / "worker.whl").write_bytes(b"wheel")

            generate_manifest(
                root,
                "worker-manifest.json",
                {"verificationStatus": "verified", "worker": "worker"},
            )

            manifest = json.loads((root / "worker-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(
                [entry["path"] for entry in manifest["files"]],
                ["requirements.lock", "wheelhouse/worker.whl"],
            )
            self.assertEqual(
                manifest["files"][1]["sha256"], hashlib.sha256(b"wheel").hexdigest()
            )

    def test_rejects_manifest_name_outside_asset_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "assets"
            root.mkdir()
            outside = Path(directory) / "manifest.json"

            with self.assertRaisesRegex(ValueError, "manifest name"):
                generate_manifest(root, "../manifest.json", {"verificationStatus": "verified"})

            self.assertFalse(outside.exists())

    @unittest.skipUnless(hasattr(Path, "symlink_to"), "symlinks unsupported")
    def test_rejects_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_bytes(b"data")
            link = root / "link"
            try:
                link.symlink_to(target)
            except OSError:
                self.skipTest("symlink creation is not permitted")

            with self.assertRaisesRegex(ValueError, "symlink"):
                generate_manifest(root, "manifest.json", {"verificationStatus": "verified"})


if __name__ == "__main__":
    unittest.main()
