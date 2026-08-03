import ast
import hashlib
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "verify-assets.py"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class AssetVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_directory = tempfile.TemporaryDirectory()
        self.bundle = Path(self.temp_directory.name) / "bundle"
        self._make_worker(
            "embedding-worker",
            "resume-embedding-worker",
            "3.10",
            "resume_embedding_worker-0.1.0-py3-none-any.whl",
        )
        self._make_worker(
            "ocr-worker",
            "resume-ocr-worker",
            "3.12",
            "resume_ocr_worker-0.1.0-py3-none-any.whl",
        )
        self._make_model(
            "Qwen3-Embedding-8B",
            "Qwen/Qwen3-Embedding-8B",
            "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af",
            dimensions=4096,
        )
        self._make_model(
            "DeepSeek-OCR-2",
            "deepseek-ai/DeepSeek-OCR-2",
            "aaa02f3811945a91062062994c5c4a3f4c0af2b0",
            custom_code=True,
        )
        self._make_conda_channel()

    def tearDown(self) -> None:
        self.temp_directory.cleanup()

    def test_valid_bundle_returns_stable_sha256_fingerprint(self) -> None:
        verifier = self._load_verifier()

        first = verifier.verify_bundle(self.bundle)
        second = verifier.verify_bundle(self.bundle)

        self.assertRegex(first, r"^[0-9a-f]{64}$")
        self.assertEqual(first, second)

    def test_fingerprint_changes_when_verified_payload_changes(self) -> None:
        verifier = self._load_verifier()
        first = verifier.verify_bundle(self.bundle)
        model_root = self.bundle / "models/Qwen3-Embedding-8B"
        weights = model_root / "weights.bin"
        weights.write_bytes(b"updated weights")
        self._refresh_manifest_hash(model_root, "model-manifest.json", "weights.bin")

        second = verifier.verify_bundle(self.bundle)

        self.assertNotEqual(first, second)

    def test_fingerprint_changes_when_manifest_bytes_change(self) -> None:
        verifier = self._load_verifier()
        first = verifier.verify_bundle(self.bundle)
        manifest_path = self.bundle / "models/Qwen3-Embedding-8B/model-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

        second = verifier.verify_bundle(self.bundle)

        self.assertNotEqual(first, second)

    def test_rejects_checksum_mismatch(self) -> None:
        verifier = self._load_verifier()
        config = self.bundle / "models/Qwen3-Embedding-8B/config.json"
        config.write_text("corrupt", encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "hash mismatch"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_conda_package_hash_mismatch(self) -> None:
        verifier = self._load_verifier()
        package = self.bundle / "conda-channel/linux-64/python-fixture.conda"
        package.write_bytes(b"tampered data")

        with self.assertRaisesRegex(verifier.VerificationError, "Conda package hash mismatch"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_inconsistent_current_conda_repodata(self) -> None:
        verifier = self._load_verifier()
        path = self.bundle / "conda-channel/linux-64/current_repodata.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        value["packages.conda"]["python-fixture.conda"]["sha256"] = "0" * 64
        path.write_text(json.dumps(value), encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "repodata.*inconsistent"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_conda_channel_nested_directory(self) -> None:
        verifier = self._load_verifier()
        extra = self.bundle / "conda-channel/linux-64/unverified"
        extra.mkdir()
        (extra / "payload").write_bytes(b"extra")

        with self.assertRaisesRegex(verifier.VerificationError, "unsafe entry"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_unsafe_conda_package_filename_before_filesystem_access(self) -> None:
        verifier = self._load_verifier()
        path = self.bundle / "conda-channel/linux-64/repodata.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        record = value["packages.conda"].pop("python-fixture.conda")
        value["packages.conda"]["../python-fixture.conda"] = record
        path.write_text(json.dumps(value), encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "filename is unsafe"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_unreferenced_conda_package(self) -> None:
        verifier = self._load_verifier()
        (self.bundle / "conda-channel/linux-64/unlisted.conda").write_bytes(b"extra")

        with self.assertRaisesRegex(verifier.VerificationError, "Conda channel contains unreferenced files"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_missing_conda_subdir(self) -> None:
        verifier = self._load_verifier()
        noarch = self.bundle / "conda-channel/noarch"
        for child in noarch.iterdir():
            child.unlink()
        noarch.rmdir()

        with self.assertRaisesRegex(verifier.VerificationError, "Conda channel structure"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_path_traversal(self) -> None:
        verifier = self._load_verifier()
        manifest_path = self.bundle / "models/Qwen3-Embedding-8B/model-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"][0]["path"] = "../config.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "unsafe path"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_posix_and_windows_absolute_manifest_paths(self) -> None:
        verifier = self._load_verifier()
        manifest_path = self.bundle / "models/Qwen3-Embedding-8B/model-manifest.json"
        original = manifest_path.read_text(encoding="utf-8")

        for absolute_path in ("/etc/passwd", "C:/Windows/System32/config"):
            with self.subTest(path=absolute_path):
                manifest = json.loads(original)
                manifest["files"][0]["path"] = absolute_path
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

                with self.assertRaisesRegex(
                    verifier.VerificationError,
                    "file path is an unsafe path",
                ):
                    verifier.verify_bundle(self.bundle)

                manifest_path.write_text(original, encoding="utf-8")

    def test_rejects_duplicate_manifest_paths(self) -> None:
        verifier = self._load_verifier()
        manifest_path = self.bundle / "models/Qwen3-Embedding-8B/model-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"].append(dict(manifest["files"][0]))
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "duplicate path"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_duplicate_top_level_json_fields(self) -> None:
        verifier = self._load_verifier()
        manifest_path = self.bundle / "models/Qwen3-Embedding-8B/model-manifest.json"
        text = manifest_path.read_text(encoding="utf-8").replace(
            '"verificationStatus": "verified"',
            '"verificationStatus": "unverified", "verificationStatus": "verified"',
            1,
        )
        manifest_path.write_text(text, encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "duplicate JSON field"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_duplicate_nested_json_fields(self) -> None:
        verifier = self._load_verifier()
        manifest_path = self.bundle / "models/Qwen3-Embedding-8B/model-manifest.json"
        text = manifest_path.read_text(encoding="utf-8").replace(
            '"path": "config.json"',
            '"path": "decoy.json", "path": "config.json"',
            1,
        )
        manifest_path.write_text(text, encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "duplicate JSON field"):
            verifier.verify_bundle(self.bundle)

    @unittest.skipIf(os.name == "nt", "Windows symlink creation requires elevated privileges")
    def test_rejects_symlinks(self) -> None:
        verifier = self._load_verifier()
        model_root = self.bundle / "models/Qwen3-Embedding-8B"
        target = model_root / "config.json"
        target.unlink()
        target.symlink_to(model_root / "weights.bin")

        with self.assertRaisesRegex(verifier.VerificationError, "symlink"):
            verifier.verify_bundle(self.bundle)

    @unittest.skipIf(os.name == "nt", "Windows symlink creation requires elevated privileges")
    def test_rejects_top_level_directory_symlink(self) -> None:
        verifier = self._load_verifier()
        models = self.bundle / "models"
        target = self.bundle.parent / "outside-models"
        models.rename(target)
        models.symlink_to(target, target_is_directory=True)

        with self.assertRaisesRegex(verifier.VerificationError, "symlink"):
            verifier.verify_bundle(self.bundle)

    @unittest.skipIf(os.name == "nt", "Windows symlink creation requires elevated privileges")
    def test_rejects_intermediate_directory_symlink(self) -> None:
        verifier = self._load_verifier()
        wheelhouse = self.bundle / "workers/embedding-worker/wheelhouse"
        target = self.bundle.parent / "outside-wheelhouse"
        wheelhouse.rename(target)
        wheelhouse.symlink_to(target, target_is_directory=True)

        with self.assertRaisesRegex(verifier.VerificationError, "symlink"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_wrong_model_identity_or_revision(self) -> None:
        verifier = self._load_verifier()
        manifest_path = self.bundle / "models/DeepSeek-OCR-2/model-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["revision"] = "0" * 40
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "identity"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_unverified_ocr_manifest(self) -> None:
        verifier = self._load_verifier()
        manifest_path = self.bundle / "models/DeepSeek-OCR-2/model-manifest.json"
        original = manifest_path.read_text(encoding="utf-8")

        for status in ("template_unverified", "unverified", "non-verified"):
            with self.subTest(status=status):
                manifest = json.loads(original)
                manifest["verificationStatus"] = status
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

                with self.assertRaisesRegex(verifier.VerificationError, "not verified"):
                    verifier.verify_bundle(self.bundle)

                manifest_path.write_text(original, encoding="utf-8")

    def test_rejects_unverified_qwen_manifest(self) -> None:
        verifier = self._load_verifier()
        manifest_path = self.bundle / "models/Qwen3-Embedding-8B/model-manifest.json"
        original = manifest_path.read_text(encoding="utf-8")

        for status in ("template_unverified", "unverified", "non-verified"):
            with self.subTest(status=status):
                manifest = json.loads(original)
                manifest["verificationStatus"] = status
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

                with self.assertRaisesRegex(verifier.VerificationError, "not verified"):
                    verifier.verify_bundle(self.bundle)

                manifest_path.write_text(original, encoding="utf-8")

    def test_rejects_unverified_worker_manifests(self) -> None:
        verifier = self._load_verifier()
        for worker in ("embedding-worker", "ocr-worker"):
            manifest_path = self.bundle / "workers" / worker / "worker-manifest.json"
            original = manifest_path.read_text(encoding="utf-8")
            for status in ("template_unverified", "unverified", "non-verified"):
                with self.subTest(worker=worker, status=status):
                    manifest = json.loads(original)
                    manifest["verificationStatus"] = status
                    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

                    with self.assertRaisesRegex(verifier.VerificationError, "not verified"):
                        verifier.verify_bundle(self.bundle)

                    manifest_path.write_text(original, encoding="utf-8")

    def test_rejects_extra_top_level_file(self) -> None:
        verifier = self._load_verifier()
        (self.bundle / "notes.txt").write_text("not part of the bundle", encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "bundle structure"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_extra_top_level_directory(self) -> None:
        verifier = self._load_verifier()
        (self.bundle / "staging").mkdir()

        with self.assertRaisesRegex(verifier.VerificationError, "bundle structure"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_extra_worker_directory(self) -> None:
        verifier = self._load_verifier()
        (self.bundle / "workers/unreviewed-worker").mkdir()

        with self.assertRaisesRegex(verifier.VerificationError, "workers structure"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_extra_model_directory(self) -> None:
        verifier = self._load_verifier()
        (self.bundle / "models/unreviewed-model").mkdir()

        with self.assertRaisesRegex(verifier.VerificationError, "models structure"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_extra_intermediate_files(self) -> None:
        verifier = self._load_verifier()

        for relative, message in (
            ("models/notes.txt", "models structure"),
            ("workers/notes.txt", "workers structure"),
        ):
            with self.subTest(path=relative):
                extra = self.bundle / relative
                extra.write_text("not part of the bundle", encoding="utf-8")

                with self.assertRaisesRegex(verifier.VerificationError, message):
                    verifier.verify_bundle(self.bundle)

                extra.unlink()

    def test_rejects_worker_root_extra_directory(self) -> None:
        verifier = self._load_verifier()
        (self.bundle / "workers/embedding-worker/unreviewed").mkdir()

        with self.assertRaisesRegex(verifier.VerificationError, "Worker structure"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_empty_model_directory_not_covered_by_files(self) -> None:
        verifier = self._load_verifier()
        (self.bundle / "models/Qwen3-Embedding-8B/empty").mkdir()

        with self.assertRaisesRegex(verifier.VerificationError, "directory closure"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_empty_worker_directory_not_covered_by_files(self) -> None:
        verifier = self._load_verifier()
        (self.bundle / "workers/embedding-worker/wheelhouse/empty").mkdir()

        with self.assertRaisesRegex(verifier.VerificationError, "directory closure"):
            verifier.verify_bundle(self.bundle)

    def test_verifier_is_python_3_8_parseable(self) -> None:
        ast.parse(SCRIPT.read_text(encoding="utf-8"), filename=str(SCRIPT), feature_version=(3, 8))

    def test_rejects_unlisted_files(self) -> None:
        verifier = self._load_verifier()
        (self.bundle / "workers/embedding-worker/wheelhouse/extra.whl").write_bytes(b"extra")

        with self.assertRaisesRegex(verifier.VerificationError, "does not exactly cover"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_unhashed_requirement_lock(self) -> None:
        verifier = self._load_verifier()
        worker_root = self.bundle / "workers/ocr-worker"
        lock_path = worker_root / "requirements.lock"
        lock_path.write_text("--require-hashes\nfastapi==0.115.12\n", encoding="utf-8")
        self._refresh_worker_hash(worker_root, "requirements.lock")

        with self.assertRaisesRegex(verifier.VerificationError, "hash-locked"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_external_blocker_lock_even_when_manifest_hash_matches(self) -> None:
        verifier = self._load_verifier()
        worker_root = self.bundle / "workers/ocr-worker"
        lock_path = worker_root / "requirements.lock"
        lock_path.write_text(
            "# EXTERNAL ACCEPTANCE BLOCKER\n--require-hashes\nfastapi==0.115.12 \\\n+    --hash=sha256:" + "a" * 64 + "\n",
            encoding="utf-8",
        )
        self._refresh_worker_hash(worker_root, "requirements.lock")

        with self.assertRaisesRegex(verifier.VerificationError, "template or blocker"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_requirement_lock_index_options(self) -> None:
        verifier = self._load_verifier()
        worker_root = self.bundle / "workers/embedding-worker"
        lock_path = worker_root / "requirements.lock"
        lock_path.write_text(
            "--require-hashes\n--extra-index-url https://packages.invalid/simple\n"
            "fastapi==0.115.12 \\\n+    --hash=sha256:" + "a" * 64 + "\n",
            encoding="utf-8",
        )
        self._refresh_worker_hash(worker_root, "requirements.lock")

        with self.assertRaisesRegex(verifier.VerificationError, "unsupported option"):
            verifier.verify_bundle(self.bundle)

    def _load_verifier(self):
        spec = importlib.util.spec_from_file_location("remote_asset_verifier", SCRIPT)
        if spec is None or spec.loader is None:
            self.fail("could not load verifier module")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _make_worker(self, directory: str, worker: str, python: str, wheel_name: str) -> None:
        root = self.bundle / "workers" / directory
        wheelhouse = root / "wheelhouse"
        wheelhouse.mkdir(parents=True)
        lock = root / "requirements.lock"
        lock.write_text(
            "--require-hashes\nfastapi==0.115.12 \\\n+    --hash=sha256:" + "a" * 64 + "\n",
            encoding="utf-8",
        )
        wheel = wheelhouse / wheel_name
        wheel.write_bytes(b"fixture wheel")
        manifest = {
            "verificationStatus": "verified",
            "worker": worker,
            "python": python,
            "wheel": f"wheelhouse/{wheel_name}",
            "files": [
                {"path": "requirements.lock", "sha256": sha256(lock)},
                {"path": f"wheelhouse/{wheel_name}", "sha256": sha256(wheel)},
            ],
        }
        (root / "worker-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def _make_conda_channel(self) -> None:
        root = self.bundle / "conda-channel"
        for subdir, package_name, payload in (
            ("linux-64", "python-fixture.conda", b"linux package"),
            ("noarch", "pip-fixture.conda", b"noarch package"),
        ):
            directory = root / subdir
            directory.mkdir(parents=True)
            package = directory / package_name
            package.write_bytes(payload)
            record = {
                package_name: {
                    "name": "python" if subdir == "linux-64" else "pip",
                    "version": "3.10.0" if subdir == "linux-64" else "1.0",
                    "build": "fixture",
                    "build_number": 0,
                    "subdir": subdir,
                    "depends": [],
                    "sha256": sha256(package),
                    "size": package.stat().st_size,
                }
            }
            repodata = {"info": {"subdir": subdir}, "packages": {}, "packages.conda": record}
            (directory / "repodata.json").write_text(json.dumps(repodata), encoding="utf-8")
            (directory / "current_repodata.json").write_text(json.dumps(repodata), encoding="utf-8")

    def _make_model(
        self,
        directory: str,
        model: str,
        revision: str,
        *,
        dimensions: int | None = None,
        custom_code: bool = False,
    ) -> None:
        root = self.bundle / "models" / directory
        root.mkdir(parents=True)
        config = root / "config.json"
        config.write_text('{"fixture": true}', encoding="utf-8")
        weights = root / "weights.bin"
        weights.write_bytes(b"weights")
        files = [
            {"path": "config.json", "sha256": sha256(config)},
            {"path": "weights.bin", "sha256": sha256(weights)},
        ]
        manifest: dict[str, object] = {
            "verificationStatus": "verified",
            "model": model,
            "revision": revision,
            "files": files,
        }
        if dimensions is not None:
            manifest["dimensions"] = dimensions
        if custom_code:
            modeling = root / "modeling_deepseekocr.py"
            modeling.write_text("# reviewed fixture", encoding="utf-8")
            files.append({"path": modeling.name, "sha256": sha256(modeling)})
            manifest["verificationStatus"] = "verified"
            manifest["customCodeFiles"] = [modeling.name]
        (root / "model-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def _refresh_worker_hash(self, worker_root: Path, relative_path: str) -> None:
        self._refresh_manifest_hash(worker_root, "worker-manifest.json", relative_path)

    def _refresh_manifest_hash(
        self,
        root: Path,
        manifest_name: str,
        relative_path: str,
    ) -> None:
        manifest_path = root / manifest_name
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for item in manifest["files"]:
            if item["path"] == relative_path:
                item["sha256"] = sha256(root / relative_path)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
