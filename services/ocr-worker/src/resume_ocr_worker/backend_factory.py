from collections.abc import Callable
from typing import Any

from .types import OcrBackend


BackendLoader = Callable[[Any], OcrBackend]


def create_backend(
    settings: Any,
    *,
    pytorch_loader: BackendLoader | None = None,
    mindspore_loader: BackendLoader | None = None,
) -> OcrBackend:
    """Create exactly one explicitly configured runtime backend."""
    runtime = getattr(settings, "runtime", "pytorch")
    if runtime == "pytorch":
        if pytorch_loader is None:
            from .backends.pytorch_backend import PyTorchBackend

            pytorch_loader = PyTorchBackend
        return pytorch_loader(settings)
    if runtime == "mindspore_lite":
        if mindspore_loader is None:
            from .backends.mindspore_lite_backend import MindSporeLiteBackend

            mindspore_loader = MindSporeLiteBackend
        return mindspore_loader(settings)
    raise ValueError("Unsupported OCR runtime.")


__all__ = ["create_backend"]
