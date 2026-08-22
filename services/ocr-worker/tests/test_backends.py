from dataclasses import dataclass, replace
from io import BytesIO
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from resume_ocr_worker.backend_factory import create_backend
from resume_ocr_worker.backends.mindspore_lite_backend import (
    MindSporeLiteBackend,
    clip_bbox,
    decode_ctc_logits,
    decode_detector_boxes,
    normalize_image,
    sort_reading_order,
)
from resume_ocr_worker.types import OcrBlock, OcrResult, OCR_MODEL, OCR_REVISION


def png_bytes() -> bytes:
    image = Image.new("RGB", (1, 1), color="white")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


PNG = png_bytes()


@dataclass(frozen=True)
class Settings:
    model: str = OCR_MODEL
    revision: str = OCR_REVISION
    runtime: str = "pytorch"
    model_path: Path = Path(".")
    manifest_path: Path = Path("model-manifest.json")
    temp_dir: Path = Path(".")
    device: str = "cuda:0"


class FakeBackend:
    model = OCR_MODEL
    revision = OCR_REVISION
    runtime = "pytorch"
    ready = True

    def recognize(self, image_bytes: bytes) -> OcrResult:
        return OcrResult(
            text="# Resume",
            blocks=[],
            model=OCR_MODEL,
            revision=OCR_REVISION,
            runtime="pytorch",
        )


def test_backend_factory_defaults_to_pytorch():
    backend = create_backend(
        Settings(),
        pytorch_loader=lambda settings: FakeBackend(),
    )

    assert backend.recognize(PNG).runtime == "pytorch"


def test_mindspore_backend_rejects_unsigned_model_package(tmp_path: Path):
    model_path = tmp_path / "model"
    model_path.mkdir()
    (model_path / "model-manifest.json").write_text(
        '{"verificationStatus":"template_unverified"}',
        encoding="utf-8",
    )
    settings = replace(
        Settings(),
        runtime="mindspore_lite",
        model_path=model_path,
        manifest_path=model_path / "model-manifest.json",
        device="ascend:0",
    )

    with pytest.raises(ValueError, match="manifest"):
        MindSporeLiteBackend(settings, lite_runtime=object())


def test_lite_decoding_helpers_normalize_clip_sort_and_decode():
    image = normalize_image(PNG)
    assert image.dtype == np.float32
    assert image.shape == (1, 3, 1, 1)

    boxes = decode_detector_boxes(
        np.asarray([[0.50, 0.50, 1.0, 1.0, 0.9], [0.1, 0.1, 0.2, 0.2, 0.2]], dtype=np.float32),
        image_size=(100, 200),
        threshold=0.5,
    )
    assert boxes == [(0, 0, 200, 100)]
    assert clip_bbox((-10, 4, 250, 101), width=200, height=100) == (0, 4, 200, 100)
    assert sort_reading_order([(50, 40, 80, 60), (5, 4, 20, 20), (30, 5, 45, 20)]) == [
        (5, 4, 20, 20),
        (30, 5, 45, 20),
        (50, 40, 80, 60),
    ]

    logits = np.zeros((1, 5, 4), dtype=np.float32)
    logits[0, :, 0] = 1
    logits[0, 0, 1] = 3
    logits[0, 1, 1] = 3
    logits[0, 2, 0] = 3
    logits[0, 3, 2] = 3
    logits[0, 4, 0] = 3
    assert decode_ctc_logits(logits, ["", "A", "B"]) == ["AB"]


def test_mindspore_backend_runs_detector_and_recognizer_with_injected_runtime(tmp_path: Path):
    model_path = tmp_path / "model"
    model_path.mkdir()
    detector = model_path / "detector.mindir"
    recognizer = model_path / "recognizer.mindir"
    vocabulary = model_path / "vocab.txt"
    detector.write_bytes(b"detector")
    recognizer.write_bytes(b"recognizer")
    vocabulary.write_text("\nA\nB\n", encoding="utf-8")
    import hashlib
    import json

    files = [
        {"path": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
        for path in (detector, recognizer, vocabulary)
    ]
    (model_path / "model-manifest.json").write_text(json.dumps({
        "model": OCR_MODEL,
        "revision": OCR_REVISION,
        "runtime": "mindspore_lite",
        "verificationStatus": "verified",
        "components": {
            "detector": detector.name,
            "recognizer": recognizer.name,
            "vocabulary": vocabulary.name,
            "preprocessingVersion": "ocr-preprocess-v1",
        },
        "files": files,
        "customCodeFiles": [],
    }), encoding="utf-8")

    class Runtime:
        def __init__(self):
            self.loaded = []

        def load(self, model_path: Path, device: str):
            self.loaded.append((model_path.name, device))
            return model_path.name

        def run(self, model: object, inputs: list[np.ndarray]):
            if model == detector.name:
                return [np.asarray([[0, 0, 1, 1, 0.9]], dtype=np.float32)]
            logits = np.zeros((1, 3, 3), dtype=np.float32)
            logits[0, 0, 1] = 4
            logits[0, 1, 0] = 4
            logits[0, 2, 2] = 4
            return [logits]

    settings = replace(
        Settings(),
        runtime="mindspore_lite",
        model_path=model_path,
        manifest_path=model_path / "model-manifest.json",
        device="ascend:0",
    )
    runtime = Runtime()
    backend = MindSporeLiteBackend(settings, lite_runtime=runtime)

    result = backend.recognize(PNG)

    assert result == OcrResult(
        text="AB",
        blocks=[OcrBlock(text="AB", bbox=(0, 0, 1, 1))],
        model=OCR_MODEL,
        revision=OCR_REVISION,
        runtime="mindspore_lite",
    )
    assert runtime.loaded == [(detector.name, "ascend:0"), (recognizer.name, "ascend:0")]
