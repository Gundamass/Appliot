import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

from resume_embedding_worker.config import load_settings
from resume_embedding_worker.types import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    EMBEDDING_REVISION,
)


MODEL = EMBEDDING_MODEL
REVISION = EMBEDDING_REVISION


def token_file(root: Path, mode: int = 0o600) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / "embedding.token"
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
    weights = model_path / "weights.bin"
    weights.write_bytes(b"offline test model")
    manifest = {
        "model": MODEL,
        "revision": revision,
        "dimensions": EMBEDDING_DIMENSIONS,
        "files": [
            {
                "path": weights.name,
                "sha256": hashlib.sha256(weights.read_bytes()).hexdigest(),
            }
        ],
    }
    (model_path / "model-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return model_path


def environment(root: Path, **overrides: str) -> dict[str, str]:
    values = {
        "CUDA_VISIBLE_DEVICES": "5",
        "EMBEDDING_MODEL_PATH": str(model_directory(root)) if "EMBEDDING_MODEL_PATH" not in overrides else "",
        "EMBEDDING_MODEL": MODEL,
        "EMBEDDING_MODEL_REVISION": REVISION,
        "EMBEDDING_DIMENSIONS": str(EMBEDDING_DIMENSIONS),
        "EMBEDDING_API_TOKEN_FILE": str(token_file(root)),
    }
    values.update(overrides)
    return values


def test_settings_require_gpu_five_and_pinned_revision(tmp_path: Path):
    settings = load_settings(environment(tmp_path))

    assert settings.cuda_visible_devices == "5"
    assert settings.host == "127.0.0.1"
    assert settings.port == 18080
    assert settings.model == MODEL
    assert settings.revision == REVISION
    assert settings.dimensions == EMBEDDING_DIMENSIONS
    assert settings.api_token == "test-token"


@pytest.mark.parametrize("gpu", ["0", "5,6", "cuda:5", ""])
def test_settings_reject_any_gpu_selection_other_than_literal_five(tmp_path: Path, gpu: str):
    with pytest.raises(ValueError, match="CUDA_VISIBLE_DEVICES"):
        load_settings(environment(tmp_path, CUDA_VISIBLE_DEVICES=gpu))


def test_settings_reject_missing_or_non0600_token_file(tmp_path: Path):
    missing = tmp_path / "missing.token"
    with pytest.raises(ValueError, match="token file"):
        load_settings(environment(tmp_path, EMBEDDING_API_TOKEN_FILE=str(missing)))

    insecure = token_file(tmp_path / "insecure", mode=0o644)
    with pytest.raises(ValueError, match="0600"):
        load_settings(environment(tmp_path, EMBEDDING_API_TOKEN_FILE=str(insecure)))


def test_settings_reject_non_loopback_host_wrong_dimension_and_missing_model(tmp_path: Path):
    with pytest.raises(ValueError, match="loopback"):
        load_settings(environment(tmp_path, EMBEDDING_HOST="0.0.0.0"))

    with pytest.raises(ValueError, match="dimensions"):
        load_settings(environment(tmp_path, EMBEDDING_DIMENSIONS="1024"))

    missing = tmp_path / "missing-model"
    with pytest.raises(ValueError, match="model directory"):
        load_settings(environment(tmp_path, EMBEDDING_MODEL_PATH=str(missing)))


def test_settings_reject_manifest_identity_or_hash_mismatch(tmp_path: Path):
    model_path = model_directory(tmp_path)
    manifest_path = model_path / "model-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["revision"] = "wrong-revision"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="manifest"):
        load_settings(environment(tmp_path, EMBEDDING_MODEL_PATH=str(model_path)))

    manifest["revision"] = REVISION
    manifest["files"][0]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="hash"):
        load_settings(environment(tmp_path, EMBEDDING_MODEL_PATH=str(model_path)))


def test_settings_reject_manifest_missing_file(tmp_path: Path):
    model_path = model_directory(tmp_path)
    manifest_path = model_path / "model-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"][0]["path"] = "missing.bin"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(ValueError, match="manifest"):
        load_settings(environment(tmp_path, EMBEDDING_MODEL_PATH=str(model_path)))
