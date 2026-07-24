import asyncio
import io
import logging
import time
import uuid
import warnings
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse
from PIL import Image, UnidentifiedImageError
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .auth import require_bearer_token
from .types import OcrBackend, WorkerSettings


LOGGER = logging.getLogger("resume_ocr_worker")
_IMAGE_MEDIA_TYPES = frozenset({"image/png", "image/jpeg"})


class InvalidBackendOutput(Exception):
    """The injected backend returned an unusable OCR result."""


class OcrRequestBodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_request_bytes: int, max_empty_frames: int) -> None:
        self.app = app
        self.max_request_bytes = max_request_bytes
        self.max_empty_frames = max_empty_frames

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != "/v1/ocr":
            await self.app(scope, receive, send)
            return

        content_length = Headers(scope=scope).get("content-length")
        if content_length is not None:
            try:
                declared_size = int(content_length)
            except ValueError:
                await _error_response(status.HTTP_400_BAD_REQUEST, "Invalid Content-Length.")(scope, receive, send)
                return
            if declared_size < 0:
                await _error_response(status.HTTP_400_BAD_REQUEST, "Invalid Content-Length.")(scope, receive, send)
                return
            if declared_size > self.max_request_bytes:
                await _error_response(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Request body is too large.")(
                    scope, receive, send
                )
                return

        buffered_body = bytearray()
        received_bytes = 0
        empty_frames = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue

            body = message.get("body", b"")
            received_bytes += len(body)
            if received_bytes > self.max_request_bytes:
                await _error_response(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Request body is too large.")(
                    scope, receive, send
                )
                return

            if body:
                buffered_body.extend(body)
            else:
                empty_frames += 1
                if empty_frames > self.max_empty_frames:
                    await _error_response(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Request body is too large.")(
                        scope, receive, send
                    )
                    return

            if not message.get("more_body", False):
                break

        bounded_body = bytes(buffered_body)
        replayed = False

        async def replay_receive() -> Message:
            nonlocal replayed
            if replayed:
                return {"type": "http.disconnect"}
            replayed = True
            return {"type": "http.request", "body": bounded_body, "more_body": False}

        await self.app(scope, replay_receive, send)


def create_app(backend: OcrBackend, settings: WorkerSettings) -> FastAPI:
    _validate_backend_metadata(backend, settings)
    app = FastAPI()
    app.add_middleware(
        OcrRequestBodyLimitMiddleware,
        max_request_bytes=settings.max_request_bytes,
        max_empty_frames=settings.max_empty_request_body_frames,
    )
    app.state.inference_lock = asyncio.Lock()

    def require_auth(authorization: Annotated[str | None, Header()] = None) -> None:
        require_bearer_token(authorization, settings.api_token)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "alive"}

    @app.get("/readyz", dependencies=[Depends(require_auth)], response_model=None)
    def readyz() -> dict[str, str] | JSONResponse:
        started = time.perf_counter()
        request_id = uuid.uuid4().hex
        try:
            is_ready = backend.ready
        except Exception as error:
            return _backend_failure_response(error, request_id, started)
        if not is_ready:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Worker is not ready.")
        return {"status": "ready", "model": settings.model, "modelRevision": settings.revision}

    @app.post("/v1/ocr", dependencies=[Depends(require_auth)], response_model=None)
    async def ocr(request: Request) -> dict[str, object] | JSONResponse:
        request_id = uuid.uuid4().hex
        started = time.perf_counter()
        content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in _IMAGE_MEDIA_TYPES:
            _log_rejected_request(request_id, status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "UnsupportedMediaType")
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail="Unsupported image media type.",
            )

        image_bytes = await request.body()
        if not _is_valid_image(image_bytes, settings):
            _log_rejected_request(request_id, status.HTTP_422_UNPROCESSABLE_ENTITY, "InvalidImage")
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid OCR image.")

        try:
            is_ready = backend.ready
        except Exception as error:
            return _backend_failure_response(error, request_id, started)
        if not is_ready:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Worker is not ready.")

        try:
            async with app.state.inference_lock:
                text = await asyncio.to_thread(backend.recognize, image_bytes)
            if not isinstance(text, str) or not text.strip():
                raise InvalidBackendOutput()
        except Exception as error:
            return _backend_failure_response(error, request_id, started)

        elapsed_ms = round((time.perf_counter() - started) * 1000)
        LOGGER.info(
            "ocr request completed request_id=%s status_code=%d model=%s revision=%s elapsed_ms=%d",
            request_id,
            status.HTTP_200_OK,
            settings.model,
            settings.revision,
            elapsed_ms,
        )
        return {
            "text": text,
            "model": settings.model,
            "modelRevision": settings.revision,
            "mode": "document_to_markdown",
            "elapsedMs": elapsed_ms,
        }

    return app


def _validate_backend_metadata(backend: OcrBackend, settings: WorkerSettings) -> None:
    if backend.model != settings.model or backend.revision != settings.revision:
        raise ValueError("Backend metadata does not match Worker settings.")


def _is_valid_image(image_bytes: bytes, settings: WorkerSettings) -> bool:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(image_bytes)) as image:
                width, height = image.size
                image.verify()
    except (Image.DecompressionBombError, Image.DecompressionBombWarning, OSError, SyntaxError, UnidentifiedImageError):
        return False
    return (
        width <= settings.max_image_dimension
        and height <= settings.max_image_dimension
        and width * height <= settings.max_image_area
    )


def _backend_failure_response(error: Exception, request_id: str, started: float) -> JSONResponse:
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    LOGGER.info(
        "ocr request failed request_id=%s elapsed_ms=%d error_class=%s",
        request_id,
        elapsed_ms,
        type(error).__name__,
    )
    return _error_response(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "OCR temporarily unavailable.",
        request_id=request_id,
    )


def _log_rejected_request(request_id: str, status_code: int, error_class: str) -> None:
    LOGGER.info(
        "ocr request rejected request_id=%s status_code=%d error_class=%s",
        request_id,
        status_code,
        error_class,
    )


def _error_response(status_code: int, detail: str, request_id: str | None = None) -> JSONResponse:
    body: dict[str, str] = {"detail": detail}
    if request_id is not None:
        body["requestId"] = request_id
    return JSONResponse(status_code=status_code, content=body)
