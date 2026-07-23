import logging
import math
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

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


def create_app(backend: EmbeddingBackend, settings: WorkerSettings) -> FastAPI:
    _validate_backend_metadata(backend, settings)
    app = FastAPI()

    def require_auth(authorization: Annotated[str | None, Header()] = None) -> None:
        require_bearer_token(authorization, settings.api_token)

    @app.middleware("http")
    async def reject_oversized_bodies(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        if request.method == "POST" and request.url.path == "/v1/embeddings":
            content_length = request.headers.get("content-length")
            if content_length is not None:
                try:
                    declared_size = int(content_length)
                except ValueError:
                    return _error_response(status.HTTP_400_BAD_REQUEST, "Invalid Content-Length.")
                if declared_size < 0:
                    return _error_response(status.HTTP_400_BAD_REQUEST, "Invalid Content-Length.")
                if declared_size > settings.max_request_bytes:
                    return _error_response(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Request body is too large.")
        return await call_next(request)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "alive"}

    @app.get("/readyz", dependencies=[Depends(require_auth)])
    def readyz() -> dict[str, str | int]:
        if not backend.ready:
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
        if not backend.ready:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Worker is not ready.",
            )

        started = time.perf_counter()
        request_id = uuid.uuid4().hex
        try:
            vectors = backend.embed(request.input)
            _validate_vectors(vectors, len(request.input), settings.dimensions)
        except Exception as error:
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            LOGGER.info(
                "embedding request failed request_id=%s count=%d elapsed_ms=%d error_class=%s",
                request_id,
                len(request.input),
                elapsed_ms,
                type(error).__name__,
            )
            return _error_response(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "Embedding temporarily unavailable.",
                request_id=request_id,
            )

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
