"""Runtime-specific OCR backend implementations."""

from .mindspore_lite_backend import MindSporeLiteBackend
from .pytorch_backend import PyTorchBackend

__all__ = ["MindSporeLiteBackend", "PyTorchBackend"]
