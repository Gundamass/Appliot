import logging
import math
import threading
import time
import uuid
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .auth import require_bearer_token
from .types import (
    EmbeddingBackend,
    MAX_TEXT_CHARACTERS,
    UNIT_NORM_TOLERANCE,
    WorkerSettings,
)


LOGGER = logging.getLogger("resume_embedding_worker")


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: str
    input: list[str] = Field(min_length=1, max_length=32)

    @field_validator("input")
    @classmethod
    def validate_texts(cls, texts: list[str]) -> list[str]:
        for text in texts:
            if not text.strip():
                raise ValueError("input text must not be blank")
            if len(text) > MAX_TEXT_CHARACTERS:
                raise ValueError("input text is too long")
        return texts


class InvalidBackendOutput(Exception):
    """The injected backend violated the Worker response contract."""


class EmbeddingRequestBodyLimitMiddleware:
    def __init__(self, app: ASGIApp, max_request_bytes: int, max_empty_frames: int) -> None:
        self.app = app
        self.max_request_bytes = max_request_bytes
        self.max_empty_frames = max_empty_frames

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != "/v1/embeddings":
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
                    scope,
                    receive,
                    send,
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
                    scope,
                    receive,
                    send,
                )
                return

            if body:
                buffered_body.extend(body)
            else:
                empty_frames += 1
                if empty_frames > self.max_empty_frames:
                    await _error_response(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Request body is too large.")(
                        scope,
                        receive,
                        send,
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


def create_app(backend: EmbeddingBackend, settings: WorkerSettings) -> FastAPI:
    _validate_backend_metadata(backend, settings)
    app = FastAPI()
    app.add_middleware(
        EmbeddingRequestBodyLimitMiddleware,
        max_request_bytes=settings.max_request_bytes,
        max_empty_frames=settings.max_empty_request_body_frames,
    )
    inference_lock = threading.Lock()

    def require_auth(authorization: Annotated[str | None, Header()] = None) -> None:
        require_bearer_token(authorization, settings.api_token)

    @app.exception_handler(RequestValidationError)
    async def invalid_embedding_request(_: Request, __: RequestValidationError) -> JSONResponse:
        return _error_response(status.HTTP_422_UNPROCESSABLE_ENTITY, "Invalid embedding request.")

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "alive"}

    @app.get("/readyz", dependencies=[Depends(require_auth)], response_model=None)
    def readyz() -> dict[str, str | int] | JSONResponse:
        started = time.perf_counter()
        request_id = uuid.uuid4().hex
        try:
            is_ready = backend.ready
        except Exception as error:
            return _backend_failure_response(error, request_id, 0, started)
        if not is_ready:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Worker is not ready.",
            )
        return {
            "status": "ready",
            "model": settings.model,
            "modelRevision": settings.revision,
            "dimensions": settings.dimensions,
        }

    @app.post("/v1/embeddings", dependencies=[Depends(require_auth)], response_model=None)
    def embeddings(request: EmbeddingRequest) -> dict[str, object] | JSONResponse:
        if request.model != settings.model:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unsupported embedding model.",
            )
        started = time.perf_counter()
        request_id = uuid.uuid4().hex
        try:
            is_ready = backend.ready
        except Exception as error:
            return _backend_failure_response(error, request_id, len(request.input), started)
        if not is_ready:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Worker is not ready.",
            )
        try:
            with inference_lock:
                vectors = backend.embed(request.input)
                _validate_vectors(vectors, len(request.input), settings.dimensions)
        except Exception as error:
            return _backend_failure_response(error, request_id, len(request.input), started)

        return {
            "model": settings.model,
            "modelRevision": settings.revision,
            "dimensions": settings.dimensions,
            "data": [
                {"index": index, "embedding": vector}
                for index, vector in enumerate(vectors)
            ],
        }

    return app


def _validate_backend_metadata(backend: EmbeddingBackend, settings: WorkerSettings) -> None:
    if (
        backend.model != settings.model
        or backend.revision != settings.revision
        or backend.dimensions != settings.dimensions
    ):
        raise ValueError("Backend metadata does not match Worker settings.")


def _backend_failure_response(error: Exception, request_id: str, count: int, started: float) -> JSONResponse:
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    LOGGER.info(
        "embedding request failed request_id=%s count=%d elapsed_ms=%d error_class=%s",
        request_id,
        count,
        elapsed_ms,
        type(error).__name__,
    )
    return _error_response(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "Embedding temporarily unavailable.",
        request_id=request_id,
    )


def _validate_vectors(vectors: object, expected_count: int, dimensions: int) -> None:
    if not isinstance(vectors, list) or len(vectors) != expected_count:
        raise InvalidBackendOutput()

    for vector in vectors:
        if not isinstance(vector, list) or len(vector) != dimensions:
            raise InvalidBackendOutput()
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in vector):
            raise InvalidBackendOutput()
        if any(not math.isfinite(value) for value in vector):
            raise InvalidBackendOutput()
        norm = math.sqrt(sum(value * value for value in vector))
        if abs(norm - 1.0) > UNIT_NORM_TOLERANCE:
            raise InvalidBackendOutput()


def _error_response(status_code: int, detail: str, request_id: str | None = None) -> JSONResponse:
    body: dict[str, str] = {"detail": detail}
    if request_id is not None:
        body["requestId"] = request_id
    return JSONResponse(status_code=status_code, content=body)
