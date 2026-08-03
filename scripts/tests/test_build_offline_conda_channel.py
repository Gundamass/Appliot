import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "build_offline_conda_channel.py"


class OfflineCondaChannelBuilderTests(unittest.TestCase):
    def setUp(self) -> None:
        spec = importlib.util.spec_from_file_location("offline_conda_builder", SCRIPT)
        if spec is None or spec.loader is None:
            self.fail("could not load builder")
        self.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.builder)

    def test_merges_plans_downloads_once_and_writes_exact_repodata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            payloads = {
                "https://repo.anaconda.com/pkgs/main/linux-64/python.conda": b"python",
                "https://repo.anaconda.com/pkgs/main/noarch/pip.conda": b"pip",
            }
            plans = [
                self._plan([self._record(url, data) for url, data in payloads.items()]),
                self._plan([self._record(next(iter(payloads)), payloads[next(iter(payloads))])]),
            ]
            calls = []

            def download(url, destination):
                calls.append(url)
                destination.write_bytes(payloads[url])

            self.builder.build_channel(plans, root, download=download)

            self.assertEqual(sorted(calls), sorted(payloads))
            linux = json.loads((root / "linux-64/repodata.json").read_text(encoding="utf-8"))
            noarch = json.loads((root / "noarch/repodata.json").read_text(encoding="utf-8"))
            self.assertEqual(set(linux["packages.conda"]), {"python.conda"})
            self.assertEqual(set(noarch["packages.conda"]), {"pip.conda"})
            self.assertEqual(linux, json.loads((root / "linux-64/current_repodata.json").read_text()))

    def test_rejects_unapproved_download_host_before_network(self) -> None:
        record = self._record("https://evil.example/linux-64/python.conda", b"python")
        with tempfile.TemporaryDirectory() as temporary:
            calls = []
            with self.assertRaisesRegex(self.builder.BuildError, "download host"):
                self.builder.build_channel(
                    [self._plan([record])], Path(temporary),
                    download=lambda *_args: calls.append(True),
                )
            self.assertEqual(calls, [])

    def test_rejects_download_hash_mismatch_and_removes_partial_file(self) -> None:
        url = "https://repo.anaconda.com/pkgs/main/linux-64/python.conda"
        record = self._record(url, b"expected")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(self.builder.BuildError, "hash mismatch"):
                self.builder.build_channel(
                    [self._plan([record])], root,
                    download=lambda _url, destination: destination.write_bytes(b"tampered"),
                )
            self.assertFalse((root / "linux-64/python.conda").exists())

    def test_rejects_conflicting_records_for_same_filename(self) -> None:
        first = self._record("https://repo.anaconda.com/pkgs/main/linux-64/python.conda", b"first")
        second = self._record("https://repo.anaconda.com/pkgs/main/linux-64/python.conda", b"second")
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(self.builder.BuildError, "conflicting"):
                self.builder.build_channel(
                    [self._plan([first]), self._plan([second])], Path(temporary),
                    download=lambda *_args: None,
                )

    @staticmethod
    def _plan(records):
        return {"success": True, "actions": {"FETCH": records}}

    @staticmethod
    def _record(url: str, payload: bytes):
        filename = url.rsplit("/", 1)[1]
        subdir = url.split("/")[-2]
        return {
            "name": filename.split(".", 1)[0],
            "version": "1.0",
            "build": "fixture",
            "build_number": 0,
            "depends": [],
            "constrains": [],
            "license": "fixture",
            "subdir": subdir,
            "fn": filename,
            "url": url,
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }


if __name__ == "__main__":
    unittest.main()
