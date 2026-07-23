from dataclasses import dataclass
from typing import Protocol


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18080
EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B"
EMBEDDING_REVISION = "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af"
EMBEDDING_DIMENSIONS = 4096
EMBEDDING_DTYPE = "float16"
MAX_REQUEST_BYTES = 1_048_576
MAX_TEXT_CHARACTERS = 30_000
UNIT_NORM_TOLERANCE = 1e-3


@dataclass(frozen=True)
class WorkerSettings:
    api_token: str
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    model: str = EMBEDDING_MODEL
    revision: str = EMBEDDING_REVISION
    dimensions: int = EMBEDDING_DIMENSIONS
    dtype: str = EMBEDDING_DTYPE
    max_request_bytes: int = MAX_REQUEST_BYTES
    max_text_characters: int = MAX_TEXT_CHARACTERS


class EmbeddingBackend(Protocol):
    model: str
    revision: str
    dimensions: int

    @property
    def ready(self) -> bool:
        ...

    def embed(self, texts: list[str]) -> list[list[float]]:
        ...
