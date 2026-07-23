import math
from typing import Any

from .config import OfflineWorkerSettings
from .types import UNIT_NORM_TOLERANCE

# Keep worker tests model-free. Production dependencies are imported only when
# the constructor is not supplied with test doubles.
SentenceTransformer = None
torch = None


class QwenEmbeddingBackend:
    model: str
    revision: str
    dimensions: int

    def __init__(
        self,
        settings: OfflineWorkerSettings,
        *,
        sentence_transformer_cls: Any = None,
        torch_module: Any = None,
    ) -> None:
        transformer_cls = sentence_transformer_cls
        if transformer_cls is None:
            global SentenceTransformer
            if SentenceTransformer is None:
                from sentence_transformers import SentenceTransformer as imported_sentence_transformer  # type: ignore[import-not-found]

                SentenceTransformer = imported_sentence_transformer
            transformer_cls = SentenceTransformer

        torch_runtime = torch_module
        if torch_runtime is None:
            global torch
            if torch is None:
                import torch as imported_torch

                torch = imported_torch
            torch_runtime = torch
        if transformer_cls is None or torch_runtime is None:
            raise RuntimeError("SentenceTransformer and torch are required to load the offline backend.")

        self.model = settings.model
        self.revision = settings.revision
        self.dimensions = settings.dimensions
        self._batch_size = settings.batch_size
        self._ready = False
        self._model = transformer_cls(
            settings.model_path,
            device="cuda:0",
            model_kwargs={"torch_dtype": torch_runtime.float16, "attn_implementation": "sdpa"},
            tokenizer_kwargs={"padding_side": "left"},
            local_files_only=True,
        )
        warmup_vectors = self._encode(["__resume_embedding_worker_warmup__"])
        _validate_vectors(warmup_vectors, 1, self.dimensions)
        self._ready = True

    @property
    def ready(self) -> bool:
        return self._ready

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not self._ready:
            raise RuntimeError("Embedding backend is not ready.")
        vectors = self._encode(texts)
        return _validate_vectors(vectors, len(texts), self.dimensions)

    def _encode(self, texts: list[str]) -> object:
        return self._model.encode(
            texts,
            batch_size=self._batch_size,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )


def _validate_vectors(value: object, expected_count: int, dimensions: int) -> list[list[float]]:
    converted = value.tolist() if hasattr(value, "tolist") else value
    if not isinstance(converted, list) or len(converted) != expected_count:
        raise ValueError("Embedding output count is invalid.")

    vectors: list[list[float]] = []
    for vector in converted:
        if not isinstance(vector, list) or len(vector) != dimensions:
            raise ValueError("Embedding output dimensions are invalid.")
        if any(isinstance(item, bool) or not isinstance(item, (int, float)) for item in vector):
            raise ValueError("Embedding output contains a non-numeric value.")
        if any(not math.isfinite(item) for item in vector):
            raise ValueError("Embedding output must contain only finite values.")
        norm = math.sqrt(sum(item * item for item in vector))
        if abs(norm - 1.0) > UNIT_NORM_TOLERANCE:
            raise ValueError("Embedding output must be unit normalized.")
        vectors.append([float(item) for item in vector])
    return vectors
