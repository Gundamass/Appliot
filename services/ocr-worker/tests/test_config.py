import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

import resume_ocr_worker.config as config
from resume_ocr_worker.config import load_settings
from resume_ocr_worker.types import OCR_MODEL, OCR_REVISION


MODEL = OCR_MODEL
REVISION = OCR_REVISION
WORKER_DIRECTORY = Path(__file__).parents[1]


def token_file(root: Path, mode: int = 0o600) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / "ocr.token"
    path.write_text("test-token\n", encoding="utf-8")
    os.chmod(path, mode)
    if os.name == "nt" and mode == 0o600:
        subprocess.run(["icacls", str(path), "/inheritance:r"], check=True, capture_output=True)
        subprocess.run(
            ["icacls", str(path), "/grant:r", f"{os.environ['USERNAME']}:(F)"],
            check=True,
            capture_output=True,
        )
    return path


def model_directory(root: Path, *, revision: str = REVISION) -> Path:
    model_path = root / "model"
    model_path.mkdir(exist_ok=True)
    for name, contents in {"config.json": b"{}", "modeling_deepseekocr.py": b"# pinned custom code\n"}.items():
        (model_path / name).write_bytes(contents)
    files = [
        {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for path in sorted(model_path.iterdir())
        if path.name != "model-manifest.json"
    ]
    manifest = {
        "model": MODEL,
        "revision": revision,
        "verificationStatus": "verified",
        "files": files,
        "customCodeFiles": ["modeling_deepseekocr.py"],
    }
    (model_path / "model-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return model_path


def environment(root: Path, **overrides: str) -> dict[str, str]:
    temp_dir = root / "tmp"
    temp_dir.mkdir(exist_ok=True)
    values = {
        "CUDA_VISIBLE_DEVICES": "5",
        "OCR_MODEL_PATH": str(model_directory(root)) if "OCR_MODEL_PATH" not in overrides else "",
        "OCR_MODEL": MODEL,
        "OCR_MODEL_REVISION": REVISION,
        "OCR_API_TOKEN_FILE": str(token_file(root)),
        "OCR_TEMP_DIR": str(temp_dir),
    }
    values.update(overrides)
    return values


def mark_paths_as_symlinks(monkeypatch, *paths: Path) -> None:
    original_is_symlink = Path.is_symlink
    symlink_paths = set(paths)

    def is_symlink(path: Path) -> bool:
        return path in symlink_paths or original_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", is_symlink)


def test_settings_pin_gpu_model_and_loopback_before_model_import(tmp_path: Path):
    sys.modules.pop("transformers", None)

    settings = load_settings(environment(tmp_path))

    assert settings.cuda_visible_devices == "5"
    assert settings.device == "cuda:0"
    assert settings.host == "127.0.0.1"
    assert settings.port == 43121
    assert settings.model == MODEL
    assert settings.revision == REVISION
    assert settings.api_token == "test-token"
    assert "transformers" not in sys.modules


@pytest.mark.parametrize("gpu", ["0", "5,6", "cuda:5", ""])
def test_settings_reject_any_gpu_selection_other_than_literal_five(tmp_path: Path, gpu: str):
    with pytest.raises(ValueError, match="CUDA_VISIBLE_DEVICES"):
        load_settings(environment(tmp_path, CUDA_VISIBLE_DEVICES=gpu))


def test_settings_reject_missing_or_non0600_token_file(tmp_path: Path):
    with pytest.raises(ValueError, match="token file"):
        load_settings(environment(tmp_path, OCR_API_TOKEN_FILE=str(tmp_path / "missing.token")))

    insecure = token_file(tmp_path / "insecure", mode=0o644)
    with pytest.raises(ValueError, match="0600"):
        load_settings(environment(tmp_path, OCR_API_TOKEN_FILE=str(insecure)))


def test_settings_reject_non_loopback_host_wrong_identity_and_missing_directories(tmp_path: Path):
    with pytest.raises(ValueError, match="loopback"):
        load_settings(environment(tmp_path, OCR_HOST="0.0.0.0"))
    with pytest.raises(ValueError, match="model is not pinned"):
        load_settings(environment(tmp_path, OCR_MODEL="other/model"))
    with pytest.raises(ValueError, match="revision is not pinned"):
        load_settings(environment(tmp_path, OCR_MODEL_REVISION="wrong-revision"))
    with pytest.raises(ValueError, match="model directory"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(tmp_path / "missing-model")))
    with pytest.raises(ValueError, match="temporary directory"):
        load_settings(environment(tmp_path, OCR_TEMP_DIR=str(tmp_path / "missing-tmp")))


def test_settings_reject_manifest_identity_hash_and_coverage_mismatch(tmp_path: Path):
    model_path = model_directory(tmp_path)
    manifest_path = model_path / "model-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["revision"] = "wrong-revision"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="identity"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(model_path)))

    manifest["revision"] = REVISION
    manifest["files"][0]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="hash"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(model_path)))

    manifest["files"][0]["sha256"] = hashlib.sha256((model_path / manifest["files"][0]["path"]).read_bytes()).hexdigest()
    manifest["files"] = [item for item in manifest["files"] if item["path"] != "config.json"]
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError, match="cover all"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(model_path)))


def test_settings_reject_unverified_or_empty_manifest_template(tmp_path: Path):
    model_path = model_directory(tmp_path)
    manifest_path = model_path / "model-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["verificationStatus"] = "template_unverified"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="not verified"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(model_path)))


def test_settings_reject_manifest_covered_python_file_missing_from_custom_code_review(tmp_path: Path):
    model_path = model_directory(tmp_path)
    unreviewed_code = model_path / "unreviewed.py"
    unreviewed_code.write_text("raise RuntimeError('must never be imported')\n", encoding="utf-8")
    manifest_path = model_path / "model-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"].append(
        {"path": unreviewed_code.name, "sha256": hashlib.sha256(unreviewed_code.read_bytes()).hexdigest()}
    )
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    sys.modules.pop("transformers", None)

    with pytest.raises(ValueError, match="custom code coverage"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(model_path)))

    assert "transformers" not in sys.modules


def test_settings_reject_symlinked_manifest(tmp_path: Path, monkeypatch):
    model_path = model_directory(tmp_path)
    manifest_path = model_path / "model-manifest.json"
    mark_paths_as_symlinks(monkeypatch, manifest_path)

    with pytest.raises(ValueError, match="symlink"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(model_path)))


def test_settings_reject_symlinked_directory_anywhere_in_snapshot(tmp_path: Path, monkeypatch):
    model_path = model_directory(tmp_path)
    linked_directory = model_path / "linked-directory"
    linked_directory.mkdir()
    mark_paths_as_symlinks(monkeypatch, linked_directory)

    with pytest.raises(ValueError, match="symlink"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(model_path)))


def test_settings_reject_listed_file_through_symlinked_parent(tmp_path: Path, monkeypatch):
    model_path = model_directory(tmp_path)
    linked_parent = model_path / "linked-parent"
    linked_parent.mkdir()
    linked_file = linked_parent / "escaped.bin"
    linked_file.write_bytes(b"outside snapshot")
    manifest_path = model_path / "model-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"].append(
        {
            "path": "linked-parent/escaped.bin",
            "sha256": hashlib.sha256(linked_file.read_bytes()).hexdigest(),
        }
    )
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    mark_paths_as_symlinks(monkeypatch, linked_parent)

    with pytest.raises(ValueError, match="symlink"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(model_path)))


def test_settings_reject_listed_file_whose_resolved_path_escapes_snapshot(tmp_path: Path, monkeypatch):
    model_path = model_directory(tmp_path)
    nested_dir = model_path / "nested"
    nested_dir.mkdir()
    listed_file = nested_dir / "escaped.bin"
    listed_file.write_bytes(b"same bytes")
    outside_file = tmp_path / "outside.bin"
    outside_file.write_bytes(b"same bytes")
    manifest_path = model_path / "model-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"].append(
        {"path": "nested/escaped.bin", "sha256": hashlib.sha256(listed_file.read_bytes()).hexdigest()}
    )
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    original_resolve = Path.resolve

    def resolve(path: Path, strict: bool = False) -> Path:
        if path == listed_file:
            return outside_file
        return original_resolve(path, strict=strict)

    monkeypatch.setattr(Path, "resolve", resolve)

    with pytest.raises(ValueError, match="outside"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(model_path)))


def test_settings_fail_closed_when_snapshot_traversal_is_incomplete(tmp_path: Path, monkeypatch):
    model_path = model_directory(tmp_path)

    def denied_walk(top, *, followlinks=False, onerror=None):
        if onerror is not None:
            onerror(PermissionError("snapshot subtree denied"))
        return iter(())

    monkeypatch.setattr(config.os, "walk", denied_walk)

    with pytest.raises(ValueError, match="inspected safely"):
        load_settings(environment(tmp_path, OCR_MODEL_PATH=str(model_path)))


def test_windows_acl_rejects_later_extra_principal_with_read_access(tmp_path: Path, monkeypatch):
    model_path = model_directory(tmp_path)
    token_path = token_file(tmp_path / "acl")
    current_user = os.environ["USERNAME"]
    acl_output = "\n".join(
        [
            f"{token_path} {current_user}:(F)",
            "                      BUILTIN\\Users:(RX)",
            "Successfully processed 1 files; Failed processing 0 files",
        ]
    )
    monkeypatch.setattr(config.os, "name", "nt")
    monkeypatch.setattr(
        config.subprocess,
        "run",
        lambda *args, **kwargs: type("Completed", (), {"returncode": 0, "stdout": acl_output})(),
    )

    with pytest.raises(ValueError, match="0600"):
        load_settings(
            environment(
                tmp_path,
                OCR_MODEL_PATH=str(model_path),
                OCR_API_TOKEN_FILE=str(token_path),
            )
        )


def test_checked_in_snapshot_and_runtime_templates_fail_closed_until_linux_acceptance():
    manifest = json.loads((WORKER_DIRECTORY / "model-manifest.json").read_text(encoding="utf-8"))
    lock = (WORKER_DIRECTORY / "requirements.lock").read_text(encoding="utf-8")

    assert manifest == {
        "model": MODEL,
        "revision": REVISION,
        "verificationStatus": "template_unverified",
        "files": [],
        "customCodeFiles": [],
    }
    assert "--require-hashes" in lock
    assert "EXTERNAL ACCEPTANCE BLOCKER" in lock
    for requirement in (
        "torch==2.6.0+cu118",
        "torchvision==0.21.0+cu118",
        "torchaudio==2.6.0+cu118",
        "transformers==4.46.3",
        "tokenizers==0.20.3",
        "flash-attn==2.7.3",
        "fastapi==0.115.12",
        "uvicorn==0.34.3",
    ):
        assert requirement in lock
