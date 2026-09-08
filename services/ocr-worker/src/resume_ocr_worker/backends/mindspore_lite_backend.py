import json
import math
from io import BytesIO
from pathlib import Path
from typing import Any, Protocol, Sequence

import numpy as np
from PIL import Image, ImageSequence

from ..config import _read_manifest_document, _validate_mindspore_manifest
from ..types import OcrBlock, OcrResult


class LiteRuntime(Protocol):
    def load(self, model_path: Path, device: str) -> object:
        ...

    def run(self, model: object, inputs: list[np.ndarray]) -> list[np.ndarray]:
        ...


class MindSporeLiteRuntime:
    """Small adapter around the platform-provided mindspore_lite wheel."""

    def __init__(self, module: Any | None = None) -> None:
        if module is None:
            try:
                import mindspore_lite as imported_module
            except (ImportError, OSError) as error:
                raise RuntimeError("mindspore_lite_runtime_unavailable") from error
            module = imported_module
        self._module = module

    def load(self, model_path: Path, device: str) -> object:
        try:
            context = self._module.Context()
            target, _, device_id = device.partition(":")
            context.target = [target]
            if target == "ascend" and hasattr(context, "ascend"):
                context.ascend.device_id = int(device_id or "0")
            model = self._module.Model()
            model.build_from_file(
                str(model_path),
                self._module.ModelType.MINDIR,
                context,
            )
            return model
        except Exception as error:
            raise RuntimeError("mindspore_lite_model_load_failed") from error

    def run(self, model: object, inputs: list[np.ndarray]) -> list[np.ndarray]:
        try:
            tensors = model.get_inputs()
            if len(tensors) != len(inputs):
                raise ValueError("input_count_mismatch")
            for tensor, value in zip(tensors, inputs):
                tensor.set_data_from_numpy(value)
            outputs = model.predict(tensors)
            return [output.get_data_to_numpy() for output in outputs]
        except Exception as error:
            raise RuntimeError("mindspore_lite_inference_failed") from error


class MindSporeLiteBackend:
    model: str
    revision: str
    runtime = "mindspore_lite"

    def __init__(
        self,
        settings: Any,
        *,
        lite_runtime: LiteRuntime | None = None,
        runtime: LiteRuntime | None = None,
    ) -> None:
        if getattr(settings, "runtime", "mindspore_lite") != "mindspore_lite":
            raise ValueError("MindSpore Lite backend requires runtime=mindspore_lite.")
        _validate_mindspore_manifest(
            settings.manifest_path,
            settings.model_path,
            settings.model,
            settings.revision,
        )
        model_root, _, manifest = _read_manifest_document(
            settings.manifest_path,
            settings.model_path,
            settings.model,
            settings.revision,
        )
        components = manifest["components"]
        if not isinstance(components, dict):
            raise ValueError("model-manifest.json MindSpore Lite components are incomplete.")

        injected_runtime = runtime if runtime is not None else lite_runtime
        self._runtime: LiteRuntime = injected_runtime or MindSporeLiteRuntime()
        self.model = settings.model
        self.revision = settings.revision
        self._detector = self._runtime.load(model_root / str(components["detector"]), settings.device)
        self._recognizer = self._runtime.load(model_root / str(components["recognizer"]), settings.device)
        self._vocabulary = _load_vocabulary(model_root / str(components["vocabulary"]))
        self._ready = True

    @property
    def ready(self) -> bool:
        return self._ready

    def recognize(self, image_bytes: bytes) -> OcrResult:
        image = _open_image(image_bytes)
        image_input = _normalize_pil_image(image)
        detector_outputs = self._runtime.run(self._detector, [image_input])
        detector_output = _first_output(detector_outputs, "detector")
        boxes = sort_reading_order(
            decode_detector_boxes(
                detector_output,
                image_size=(image.height, image.width),
            )
        )
        if not boxes:
            return OcrResult(
                text="",
                blocks=[],
                model=self.model,
                revision=self.revision,
                runtime="mindspore_lite",
            )

        crops = [
            _normalize_pil_image(image.crop((left, top, right, bottom)))
            for left, top, right, bottom in boxes
        ]
        recognizer_outputs = self._runtime.run(self._recognizer, crops)
        logits = _first_output(recognizer_outputs, "recognizer")
        decoded = decode_ctc_logits(logits, self._vocabulary)
        if len(decoded) != len(boxes):
            raise RuntimeError("mindspore_lite_recognizer_batch_mismatch")

        blocks = [
            OcrBlock(text=text, bbox=bbox)
            for text, bbox in zip(decoded, boxes)
            if text.strip()
        ]
        return OcrResult(
            text="\n".join(block.text for block in blocks),
            blocks=blocks,
            model=self.model,
            revision=self.revision,
            runtime="mindspore_lite",
        )


def normalize_image(image_bytes: bytes) -> np.ndarray:
    """Convert one RGB image to a batch-first, channel-first float tensor."""
    return _normalize_pil_image(_open_image(image_bytes))


def _normalize_pil_image(image: Image.Image) -> np.ndarray:
    rgb = image.convert("RGB")
    values = np.asarray(rgb, dtype=np.float32) / 255.0
    return np.transpose(values, (2, 0, 1))[None, ...]


def decode_detector_boxes(
    predictions: np.ndarray,
    *,
    image_size: tuple[int, int],
    threshold: float = 0.5,
) -> list[tuple[int, int, int, int]]:
    """Decode normalized ``cx, cy, width, height, confidence`` rows."""
    array = np.asarray(predictions, dtype=np.float32)
    if array.ndim == 3 and array.shape[0] == 1:
        array = array[0]
    if array.ndim != 2 or array.shape[1] < 5:
        raise ValueError("detector output must be a two-dimensional Nx5 array")
    height, width = image_size
    if height <= 0 or width <= 0:
        raise ValueError("image dimensions must be positive")

    boxes: list[tuple[int, int, int, int]] = []
    for row in array:
        cx, cy, box_width, box_height, confidence = (float(value) for value in row[:5])
        if not all(math.isfinite(value) for value in (cx, cy, box_width, box_height, confidence)):
            continue
        if confidence < threshold or box_width <= 0 or box_height <= 0:
            continue
        if max(abs(cx), abs(cy), abs(box_width), abs(box_height)) <= 1.0:
            cx *= width
            cy *= height
            box_width *= width
            box_height *= height
        boxes.append(
            clip_bbox(
                (
                    math.floor(cx - box_width / 2),
                    math.floor(cy - box_height / 2),
                    math.ceil(cx + box_width / 2),
                    math.ceil(cy + box_height / 2),
                ),
                width=width,
                height=height,
            )
        )
    return [box for box in boxes if box[2] > box[0] and box[3] > box[1]]


def clip_bbox(
    bbox: Sequence[int | float],
    *,
    width: int,
    height: int,
) -> tuple[int, int, int, int]:
    if len(bbox) != 4 or width <= 0 or height <= 0:
        raise ValueError("bbox and image dimensions are invalid")
    left, top, right, bottom = (int(value) for value in bbox)
    return (
        max(0, min(width, left)),
        max(0, min(height, top)),
        max(0, min(width, right)),
        max(0, min(height, bottom)),
    )


def sort_reading_order(boxes: Sequence[tuple[int, int, int, int]]) -> list[tuple[int, int, int, int]]:
    """Group nearby tops into lines, then sort lines left-to-right."""
    rows: list[list[tuple[int, int, int, int]]] = []
    for box in sorted(boxes, key=lambda value: (value[1], value[0])):
        tolerance = max(4, (box[3] - box[1]) // 2)
        row = next((candidate for candidate in rows if abs(candidate[0][1] - box[1]) <= tolerance), None)
        if row is None:
            rows.append([box])
        else:
            row.append(box)
    return [box for row in rows for box in sorted(row, key=lambda value: value[0])]


def decode_ctc_logits(logits: np.ndarray, vocabulary: Sequence[str]) -> list[str]:
    array = np.asarray(logits)
    if array.ndim == 2:
        array = array[None, ...]
    if array.ndim != 3:
        raise ValueError("recognizer output must be a three-dimensional batch")
    results: list[str] = []
    for sequence in np.argmax(array, axis=-1):
        previous: int | None = None
        tokens: list[str] = []
        for raw_index in sequence:
            index = int(raw_index)
            if index == 0 or index == previous:
                previous = index
                continue
            previous = index
            if 0 <= index < len(vocabulary):
                tokens.append(vocabulary[index])
        results.append("".join(tokens).strip())
    return results


def _open_image(image_bytes: bytes) -> Image.Image:
    try:
        with Image.open(BytesIO(image_bytes)) as image:
            if getattr(image, "n_frames", 1) != 1:
                raise ValueError("multi-frame OCR images are not supported")
            image.load()
            return image.convert("RGB").copy()
    except (OSError, ValueError) as error:
        raise ValueError("OCR image cannot be decoded") from error


def _first_output(outputs: list[np.ndarray], label: str) -> np.ndarray:
    if not outputs:
        raise RuntimeError(f"mindspore_lite_{label}_output_missing")
    return np.asarray(outputs[0])


def _load_vocabulary(path: Path) -> list[str]:
    try:
        if path.suffix.lower() == ".json":
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, list):
                vocabulary = [str(token) for token in raw]
            elif isinstance(raw, dict):
                vocabulary = [str(raw[key]) for key in sorted(raw, key=lambda value: int(value))]
            else:
                raise ValueError("vocabulary must be a list or object")
        else:
            vocabulary = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("MindSpore Lite vocabulary is invalid") from error
    if not vocabulary or vocabulary[0] != "":
        vocabulary.insert(0, "")
    if len(vocabulary) < 2 or any(not isinstance(token, str) for token in vocabulary):
        raise ValueError("MindSpore Lite vocabulary is empty")
    return vocabulary


__all__ = [
    "LiteRuntime",
    "MindSporeLiteBackend",
    "MindSporeLiteRuntime",
    "clip_bbox",
    "decode_ctc_logits",
    "decode_detector_boxes",
    "normalize_image",
    "sort_reading_order",
]
