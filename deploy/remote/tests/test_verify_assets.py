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

    def tearDown(self) -> None:
        self.temp_directory.cleanup()

    def test_valid_bundle_returns_stable_sha256_fingerprint(self) -> None:
        verifier = self._load_verifier()

        first = verifier.verify_bundle(self.bundle)
        second = verifier.verify_bundle(self.bundle)

        self.assertRegex(first, r"^[0-9a-f]{64}$")
        self.assertEqual(first, second)

    def test_rejects_checksum_mismatch(self) -> None:
        verifier = self._load_verifier()
        config = self.bundle / "models/Qwen3-Embedding-8B/config.json"
        config.write_text("corrupt", encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "hash mismatch"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_path_traversal(self) -> None:
        verifier = self._load_verifier()
        manifest_path = self.bundle / "models/Qwen3-Embedding-8B/model-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"][0]["path"] = "../config.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "unsafe path"):
            verifier.verify_bundle(self.bundle)

    def test_rejects_duplicate_manifest_paths(self) -> None:
        verifier = self._load_verifier()
        manifest_path = self.bundle / "models/Qwen3-Embedding-8B/model-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"].append(dict(manifest["files"][0]))
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "duplicate path"):
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
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["verificationStatus"] = "template_unverified"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        with self.assertRaisesRegex(verifier.VerificationError, "not verified"):
            verifier.verify_bundle(self.bundle)

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
            "worker": worker,
            "python": python,
            "wheel": f"wheelhouse/{wheel_name}",
            "files": [
                {"path": "requirements.lock", "sha256": sha256(lock)},
                {"path": f"wheelhouse/{wheel_name}", "sha256": sha256(wheel)},
            ],
        }
        (root / "worker-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

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
        manifest_path = worker_root / "worker-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for item in manifest["files"]:
            if item["path"] == relative_path:
                item["sha256"] = sha256(worker_root / relative_path)
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
