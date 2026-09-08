from dataclasses import dataclass
from typing import Literal, Protocol


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 43121
OCR_MODEL = "deepseek-ai/DeepSeek-OCR-2"
OCR_REVISION = "aaa02f3811945a91062062994c5c4a3f4c0af2b0"
MAX_REQUEST_BYTES = 20 * 1024 * 1024
MAX_EMPTY_REQUEST_BODY_FRAMES = 1_024
MAX_IMAGE_DIMENSION = 10_000
MAX_IMAGE_AREA = 40_000_000
OcrRuntime = Literal["pytorch", "mindspore_lite"]
OCR_RUNTIMES = frozenset({"pytorch", "mindspore_lite"})


@dataclass(frozen=True)
class OcrBlock:
    text: str
    bbox: tuple[int, int, int, int]


@dataclass(frozen=True, eq=False)
class OcrResult:
    text: str
    blocks: list[OcrBlock]
    model: str
    revision: str
    runtime: OcrRuntime

    def __eq__(self, other: object) -> bool:
        # Keep the old model.py test/call boundary usable during the protocol migration.
        if isinstance(other, str):
            return self.text == other
        if not isinstance(other, OcrResult):
            return NotImplemented
        return (
            self.text == other.text
            and self.blocks == other.blocks
            and self.model == other.model
            and self.revision == other.revision
            and self.runtime == other.runtime
        )

    def __str__(self) -> str:
        return self.text


@dataclass(frozen=True)
class WorkerSettings:
    api_token: str
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    model: str = OCR_MODEL
    revision: str = OCR_REVISION
    runtime: OcrRuntime = "pytorch"
    max_request_bytes: int = MAX_REQUEST_BYTES
    max_empty_request_body_frames: int = MAX_EMPTY_REQUEST_BODY_FRAMES
    max_image_dimension: int = MAX_IMAGE_DIMENSION
    max_image_area: int = MAX_IMAGE_AREA


class OcrBackend(Protocol):
    model: str
    revision: str
    runtime: OcrRuntime

    @property
    def ready(self) -> bool:
        ...

    def recognize(self, image_bytes: bytes) -> OcrResult:
        ...
