"""Compatibility exports for the pre-runtime-neutral OCR import path."""

from .backends.pytorch_backend import (
    OcrInferenceError,
    PROMPT,
    PyTorchBackend,
    _WARMUP_IMAGE,
)


DeepSeekOcrBackend = PyTorchBackend

__all__ = [
    "DeepSeekOcrBackend",
    "OcrInferenceError",
    "PROMPT",
    "PyTorchBackend",
    "_WARMUP_IMAGE",
]
