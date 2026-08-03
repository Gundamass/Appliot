import math
from pathlib import Path

import numpy as np
import pytest

from resume_embedding_worker.model import QwenEmbeddingBackend
from resume_embedding_worker.types import EMBEDDING_DIMENSIONS


class FakeTorch:
    float16 = object()


class FakeSentenceTransformer:
    instances = []

    def __init__(self, model_path, **kwargs):
        self.model_path = model_path
        self.kwargs = kwargs
        self.encode_calls = []
        self.__class__.instances.append(self)

    def encode(self, texts, **kwargs):
        self.encode_calls.append((texts, kwargs))
        return np.ones((len(texts), EMBEDDING_DIMENSIONS), dtype=np.float32) / math.sqrt(EMBEDDING_DIMENSIONS)


class Settings:
    model_path = Path("/offline/model")
    model = "Qwen/Qwen3-Embedding-8B"
    revision = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af"
    dimensions = EMBEDDING_DIMENSIONS
    batch_size = 8


@pytest.fixture(autouse=True)
def clear_instances():
    FakeSentenceTransformer.instances.clear()


def test_backend_loads_once_with_offline_gpu_safe_options():
    backend = QwenEmbeddingBackend(
        Settings(),
        sentence_transformer_cls=FakeSentenceTransformer,
        torch_module=FakeTorch,
    )

    assert backend.ready is True
    assert len(FakeSentenceTransformer.instances) == 1
    model = FakeSentenceTransformer.instances[0]
    assert model.model_path == str(Settings.model_path)
    assert model.kwargs == {
        "device": "cuda:0",
        "model_kwargs": {"torch_dtype": FakeTorch.float16, "attn_implementation": "sdpa"},
        "tokenizer_kwargs": {"padding_side": "left"},
        "local_files_only": True,
    }

    vectors = backend.embed(["one", "two"])
    assert len(vectors) == 2
    assert all(len(vector) == EMBEDDING_DIMENSIONS for vector in vectors)
    assert model.encode_calls[-1] == (
        ["one", "two"],
        {
            "batch_size": 8,
            "normalize_embeddings": True,
            "convert_to_numpy": True,
            "show_progress_bar": False,
        },
    )


@pytest.mark.parametrize(
    "output, message",
    [
        (np.ones((1, EMBEDDING_DIMENSIONS - 1), dtype=np.float32), "dimensions"),
        (np.full((1, EMBEDDING_DIMENSIONS), np.nan, dtype=np.float32), "finite"),
    ],
)
def test_backend_rejects_invalid_warmup_output(output, message):
    class InvalidModel(FakeSentenceTransformer):
        def encode(self, texts, **kwargs):
            return output

    with pytest.raises(ValueError, match=message):
        QwenEmbeddingBackend(
            Settings(),
            sentence_transformer_cls=InvalidModel,
            torch_module=FakeTorch,
        )


def test_backend_rejects_non_unit_warmup_output():
    class NonUnitModel(FakeSentenceTransformer):
        def encode(self, texts, **kwargs):
            return np.ones((1, EMBEDDING_DIMENSIONS), dtype=np.float32)

    with pytest.raises(ValueError, match="unit"):
        QwenEmbeddingBackend(
            Settings(),
            sentence_transformer_cls=NonUnitModel,
            torch_module=FakeTorch,
        )
