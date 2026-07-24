import asyncio
import io
import logging
import struct
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from resume_ocr_worker.app import create_app
from resume_ocr_worker.types import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    MAX_IMAGE_AREA,
    MAX_IMAGE_DIMENSION,
    MAX_REQUEST_BYTES,
    OCR_MODEL,
    OCR_REVISION,
    WorkerSettings,
)


MODEL = OCR_MODEL
REVISION = OCR_REVISION
TOKEN = "ocr-test-token"


def png_bytes(width: int = 1, height: int = 1) -> bytes:
    image = Image.new("RGB", (width, height), color="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def declared_png_bytes(width: int, height: int) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff"))
        + chunk(b"IEND", b"")
    )


PNG_BYTES = png_bytes()


class FakeBackend:
    def __init__(self, ready: bool = True, error: Exception | None = None, result: str = "# Resume\nAda Lovelace"):
        self.model = MODEL
        self.revision = REVISION
        self._ready = ready
        self._error = error
        self._result = result
        self.calls: list[bytes] = []

    @property
    def ready(self) -> bool:
        return self._ready

    def recognize(self, image_bytes: bytes) -> str:
        self.calls.append(image_bytes)
        if self._error is not None:
            raise self._error
        return self._result


@pytest.fixture
def token() -> str:
    return TOKEN


@pytest.fixture
def backend() -> FakeBackend:
    return FakeBackend()


@pytest.fixture
def client(backend: FakeBackend, token: str) -> TestClient:
    return TestClient(create_app(backend, WorkerSettings(api_token=token)))


def authorized(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def asgi_response_without_content_length(app, chunks: list[bytes], token: str):
    async def call_app():
        request_messages = iter(
            [
                {
                    "type": "http.request",
                    "body": chunk,
                    "more_body": index < len(chunks) - 1,
                }
                for index, chunk in enumerate(chunks)
            ]
        )
        response_messages = []

        async def receive():
            return next(request_messages)

        async def send(message):
            response_messages.append(message)

        await app(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": "/v1/ocr",
                "raw_path": b"/v1/ocr",
                "query_string": b"",
                "headers": [
                    (b"authorization", f"Bearer {token}".encode()),
                    (b"content-type", b"image/png"),
                ],
                "client": ("testclient", 50000),
                "server": ("testserver", 80),
            },
            receive,
            send,
        )
        return response_messages

    return asyncio.run(call_app())


def test_worker_defaults_pin_the_deployment_contract():
    settings = WorkerSettings(api_token=TOKEN)

    assert settings.host == DEFAULT_HOST == "127.0.0.1"
    assert settings.port == DEFAULT_PORT == 43121
    assert settings.model == MODEL == "deepseek-ai/DeepSeek-OCR-2"
    assert settings.revision == REVISION == "aaa02f3811945a91062062994c5c4a3f4c0af2b0"
    assert settings.max_request_bytes == MAX_REQUEST_BYTES == 20 * 1024 * 1024
    assert settings.max_image_dimension == MAX_IMAGE_DIMENSION == 10_000
    assert settings.max_image_area == MAX_IMAGE_AREA == 40_000_000


def test_healthz_is_unauthenticated_and_alive_before_model_readiness(token: str):
    client = TestClient(create_app(FakeBackend(ready=False), WorkerSettings(api_token=token)))

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "alive"}


def test_readyz_requires_bearer_token(client: TestClient):
    response = client.get("/readyz")

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_readyz_rejects_unready_backend(token: str):
    client = TestClient(create_app(FakeBackend(ready=False), WorkerSettings(api_token=token)))

    response = client.get("/readyz", headers=authorized(token))

    assert response.status_code == 503
    assert response.json() == {"detail": "Worker is not ready."}


def test_readyz_returns_safe_model_identity(client: TestClient, token: str):
    response = client.get("/readyz", headers=authorized(token))

    assert response.status_code == 200
    assert response.json() == {"status": "ready", "model": MODEL, "modelRevision": REVISION}


def test_ocr_accepts_png_bytes_and_returns_markdown(client: TestClient, backend: FakeBackend, token: str):
    response = client.post(
        "/v1/ocr",
        headers={**authorized(token), "Content-Type": "image/png"},
        content=PNG_BYTES,
    )

    assert response.status_code == 200
    assert response.json()["text"] == "# Resume\nAda Lovelace"
    assert response.json()["model"] == MODEL
    assert response.json()["modelRevision"] == REVISION
    assert response.json()["mode"] == "document_to_markdown"
    assert isinstance(response.json()["elapsedMs"], int)
    assert response.json()["elapsedMs"] >= 0
    assert backend.calls == [PNG_BYTES]


@pytest.mark.parametrize("header", [None, "Basic credentials", "Bearer", "Bearer wrong-token"])
def test_ocr_rejects_invalid_authorization(client: TestClient, header: str | None):
    headers = {"Content-Type": "image/png"}
    if header is not None:
        headers["Authorization"] = header

    response = client.post("/v1/ocr", headers=headers, content=PNG_BYTES)

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_ocr_rejects_wrong_media_type_and_caller_url_json(client: TestClient, backend: FakeBackend, token: str):
    caller_url = "https://example.test/private-resume.png"
    response = client.post(
        "/v1/ocr",
        headers={**authorized(token), "Content-Type": "application/json"},
        json={"url": caller_url},
    )

    assert response.status_code == 415
    assert response.json() == {"detail": "Unsupported image media type."}
    assert caller_url not in response.text
    assert backend.calls == []


def test_ocr_rejects_invalid_image_bytes(client: TestClient, backend: FakeBackend, token: str):
    invalid_bytes = b"not an image"
    response = client.post(
        "/v1/ocr",
        headers={**authorized(token), "Content-Type": "image/png"},
        content=invalid_bytes,
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid OCR image."}
    assert invalid_bytes.decode() not in response.text
    assert backend.calls == []


@pytest.mark.parametrize(
    "image_bytes",
    [
        declared_png_bytes(MAX_IMAGE_DIMENSION + 1, 1),
        declared_png_bytes(8_000, 6_000),
        declared_png_bytes(MAX_IMAGE_DIMENSION + 1, MAX_IMAGE_DIMENSION + 1),
    ],
)
def test_ocr_rejects_dimension_area_and_decompression_bomb_images(
    client: TestClient, backend: FakeBackend, token: str, image_bytes: bytes
):
    response = client.post(
        "/v1/ocr",
        headers={**authorized(token), "Content-Type": "image/png"},
        content=image_bytes,
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Invalid OCR image."}
    assert backend.calls == []


def test_ocr_rejects_declared_oversized_body_before_reading(client: TestClient, backend: FakeBackend, token: str):
    response = client.post(
        "/v1/ocr",
        headers={
            **authorized(token),
            "Content-Type": "image/png",
            "Content-Length": str(MAX_REQUEST_BYTES + 1),
        },
        content=b"x",
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body is too large."}
    assert backend.calls == []


def test_ocr_rejects_oversized_headerless_chunked_body_before_validation(token: str):
    backend = FakeBackend()
    app = create_app(backend, WorkerSettings(api_token=token))

    messages = asgi_response_without_content_length(app, [b"x" * MAX_REQUEST_BYTES, b"x"], token)

    assert next(message for message in messages if message["type"] == "http.response.start")["status"] == 413
    assert b"".join(message.get("body", b"") for message in messages) == b'{"detail":"Request body is too large."}'
    assert backend.calls == []


def test_ocr_rejects_unready_backend(token: str):
    backend = FakeBackend(ready=False)
    client = TestClient(create_app(backend, WorkerSettings(api_token=token)))

    response = client.post(
        "/v1/ocr",
        headers={**authorized(token), "Content-Type": "image/png"},
        content=PNG_BYTES,
    )

    assert response.status_code == 503
    assert response.json() == {"detail": "Worker is not ready."}
    assert backend.calls == []


@pytest.mark.parametrize("result", ["", " \n\t "])
def test_ocr_rejects_blank_backend_output(token: str, result: str):
    backend = FakeBackend(result=result)
    client = TestClient(create_app(backend, WorkerSettings(api_token=token)))

    response = client.post(
        "/v1/ocr",
        headers={**authorized(token), "Content-Type": "image/png"},
        content=PNG_BYTES,
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "OCR temporarily unavailable."
    assert "text" not in response.json()


def test_ocr_serializes_concurrent_requests(token: str):
    class ConcurrentBackend(FakeBackend):
        def __init__(self):
            super().__init__()
            self._counter_lock = threading.Lock()
            self.active_recognitions = 0
            self.max_active_recognitions = 0

        def recognize(self, image_bytes: bytes) -> str:
            with self._counter_lock:
                self.active_recognitions += 1
                self.max_active_recognitions = max(self.max_active_recognitions, self.active_recognitions)
            try:
                time.sleep(0.05)
                return super().recognize(image_bytes)
            finally:
                with self._counter_lock:
                    self.active_recognitions -= 1

    backend = ConcurrentBackend()
    app = create_app(backend, WorkerSettings(api_token=token))

    async def concurrent_posts():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            return await asyncio.gather(
                *[
                    client.post(
                        "/v1/ocr",
                        headers={**authorized(token), "Content-Type": "image/png"},
                        content=PNG_BYTES,
                    )
                    for _ in range(2)
                ]
            )

    responses = asyncio.run(concurrent_posts())

    assert [response.status_code for response in responses] == [200, 200]
    assert backend.max_active_recognitions == 1


def test_ocr_uses_generic_redacted_backend_error_and_logs_no_sensitive_content(token: str, caplog):
    caller_url = "https://example.test/private-resume.png"
    output_secret = "private OCR markdown"
    backend = FakeBackend(error=RuntimeError(f"backend failed after producing {output_secret}"))
    client = TestClient(create_app(backend, WorkerSettings(api_token=token)))

    with caplog.at_level(logging.INFO, logger="resume_ocr_worker"):
        response = client.post(
            "/v1/ocr",
            headers={**authorized(token), "Content-Type": "image/png", "X-Caller-Path": caller_url},
            content=PNG_BYTES,
        )

    assert response.status_code == 503
    assert response.json()["detail"] == "OCR temporarily unavailable."
    assert isinstance(response.json()["requestId"], str)
    log_output = caplog.text
    assert caller_url not in response.text
    assert output_secret not in response.text
    assert token not in log_output
    assert caller_url not in log_output
    assert output_secret not in log_output
    assert PNG_BYTES.hex() not in log_output
    assert "RuntimeError" in log_output
