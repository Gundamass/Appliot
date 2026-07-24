from dataclasses import dataclass
from typing import Protocol


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 43121
OCR_MODEL = "deepseek-ai/DeepSeek-OCR-2"
OCR_REVISION = "aaa02f3811945a91062062994c5c4a3f4c0af2b0"
MAX_REQUEST_BYTES = 20 * 1024 * 1024
MAX_EMPTY_REQUEST_BODY_FRAMES = 1_024
MAX_IMAGE_DIMENSION = 10_000
MAX_IMAGE_AREA = 40_000_000


@dataclass(frozen=True)
class WorkerSettings:
    api_token: str
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    model: str = OCR_MODEL
    revision: str = OCR_REVISION
    max_request_bytes: int = MAX_REQUEST_BYTES
    max_empty_request_body_frames: int = MAX_EMPTY_REQUEST_BODY_FRAMES
    max_image_dimension: int = MAX_IMAGE_DIMENSION
    max_image_area: int = MAX_IMAGE_AREA


class OcrBackend(Protocol):
    model: str
    revision: str

    @property
    def ready(self) -> bool:
        ...

    def recognize(self, image_bytes: bytes) -> str:
        ...
