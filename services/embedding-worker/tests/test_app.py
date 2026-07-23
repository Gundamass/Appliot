import logging
import math

import pytest
from fastapi.testclient import TestClient

from resume_embedding_worker.app import create_app
from resume_embedding_worker.types import (
    DEFAULT_HOST,
    DEFAULT_PORT,
    EMBEDDING_DIMENSIONS,
    EMBEDDING_DTYPE,
    EMBEDDING_MODEL,
    EMBEDDING_REVISION,
    MAX_REQUEST_BYTES,
    MAX_TEXT_CHARACTERS,
    WorkerSettings,
)


MODEL = EMBEDDING_MODEL
REVISION = EMBEDDING_REVISION
TOKEN = "embedding-test-token"


class FakeBackend:
    def __init__(self, vectors=None, ready=True, error=None):
        self.model = MODEL
        self.revision = REVISION
        self.dimensions = 4
        self._vectors = vectors if vectors is not None else [[1.0, 0.0, 0.0, 0.0]]
        self._ready = ready
        self._error = error
        self.calls = []

    @property
    def ready(self):
        return self._ready

    def embed(self, texts):
        self.calls.append(texts)
        if self._error:
            raise self._error
        return self._vectors


@pytest.fixture
def token():
    return TOKEN


@pytest.fixture
def backend():
    return FakeBackend()


@pytest.fixture
def client(backend, token):
    settings = WorkerSettings(api_token=token, dimensions=backend.dimensions)
    return TestClient(create_app(backend, settings))


def authorized(token):
    return {"Authorization": f"Bearer {token}"}


def test_worker_defaults_pin_the_deployment_contract():
    settings = WorkerSettings(api_token=TOKEN)

    assert settings.host == DEFAULT_HOST == "127.0.0.1"
    assert settings.port == DEFAULT_PORT == 18080
    assert settings.model == MODEL == "Qwen/Qwen3-Embedding-8B"
    assert settings.revision == REVISION == "1d8ad4ca9b3dd8059ad90a75d4983776a23d44af"
    assert settings.dimensions == EMBEDDING_DIMENSIONS == 4096
    assert settings.dtype == EMBEDDING_DTYPE == "float16"
    assert settings.max_request_bytes == MAX_REQUEST_BYTES == 1_048_576
    assert settings.max_text_characters == MAX_TEXT_CHARACTERS == 30_000


def test_healthz_is_unauthenticated_and_alive_before_model_readiness(token):
    client = TestClient(create_app(FakeBackend(ready=False), WorkerSettings(api_token=token, dimensions=4)))

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "alive"}


def test_readyz_requires_bearer_token(client):
    response = client.get("/readyz")

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_readyz_rejects_unready_backend(token):
    client = TestClient(create_app(FakeBackend(ready=False), WorkerSettings(api_token=token, dimensions=4)))

    response = client.get("/readyz", headers=authorized(token))

    assert response.status_code == 503
    assert response.json() == {"detail": "Worker is not ready."}


def test_readyz_returns_safe_model_identity(client, token):
    response = client.get("/readyz", headers=authorized(token))

    assert response.status_code == 200
    assert response.json() == {
        "status": "ready",
        "model": MODEL,
        "modelRevision": REVISION,
        "dimensions": 4,
    }


def test_embeddings_requires_auth_and_returns_indexed_vectors(client, token):
    denied = client.post("/v1/embeddings", json={"model": MODEL, "input": ["resume"]})
    accepted = client.post(
        "/v1/embeddings",
        headers=authorized(token),
        json={"model": MODEL, "input": ["resume"]},
    )

    assert denied.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json() == {
        "model": MODEL,
        "modelRevision": REVISION,
        "dimensions": 4,
        "data": [{"index": 0, "embedding": [1.0, 0.0, 0.0, 0.0]}],
    }


@pytest.mark.parametrize("header", [None, "Basic credentials", "Bearer", "Bearer wrong-token"])
def test_embeddings_reject_invalid_authorization(client, header):
    headers = {} if header is None else {"Authorization": header}

    response = client.post("/v1/embeddings", headers=headers, json={"model": MODEL, "input": ["resume"]})

    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_embeddings_rejects_wrong_model_before_backend_execution(client, backend, token):
    response = client.post(
        "/v1/embeddings",
        headers=authorized(token),
        json={"model": "other-model", "input": ["resume"]},
    )

    assert response.status_code == 400
    assert response.json() == {"detail": "Unsupported embedding model."}
    assert backend.calls == []


@pytest.mark.parametrize(
    "input_value",
    [
        ["   "],
        ["resume"] * 33,
        ["a" * (MAX_TEXT_CHARACTERS + 1)],
    ],
)
def test_embeddings_rejects_invalid_input_before_backend_execution(client, backend, token, input_value):
    response = client.post(
        "/v1/embeddings",
        headers=authorized(token),
        json={"model": MODEL, "input": input_value},
    )

    assert response.status_code == 422
    assert backend.calls == []


def test_embeddings_rejects_declared_oversized_body_before_parsing(client, backend, token):
    response = client.post(
        "/v1/embeddings",
        headers={**authorized(token), "Content-Length": str(MAX_REQUEST_BYTES + 1)},
        content=b"not-json",
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Request body is too large."}
    assert backend.calls == []


def test_embeddings_returns_generic_unavailable_error_and_redacted_log(token, caplog):
    input_text = "private resume text"
    backend = FakeBackend(error=RuntimeError("backend failed for private resume text"))
    client = TestClient(create_app(backend, WorkerSettings(api_token=token, dimensions=4)))

    with caplog.at_level(logging.INFO, logger="resume_embedding_worker"):
        response = client.post(
            "/v1/embeddings",
            headers=authorized(token),
            json={"model": MODEL, "input": [input_text]},
        )

    assert response.status_code == 503
    body = response.json()
    assert body["detail"] == "Embedding temporarily unavailable."
    assert isinstance(body["requestId"], str)
    log_output = caplog.text
    assert input_text not in log_output
    assert token not in log_output
    assert "[1.0" not in log_output
    assert "backend failed" not in log_output
    assert "RuntimeError" in log_output


@pytest.mark.parametrize(
    "vectors",
    [
        [],
        [[1.0, 0.0, 0.0]],
        [[math.nan, 0.0, 0.0, 0.0]],
        [[0.5, 0.0, 0.0, 0.0]],
    ],
)
def test_embeddings_rejects_malformed_backend_output_without_partial_vectors(token, vectors):
    backend = FakeBackend(vectors=vectors)
    client = TestClient(create_app(backend, WorkerSettings(api_token=token, dimensions=4)))

    response = client.post(
        "/v1/embeddings",
        headers=authorized(token),
        json={"model": MODEL, "input": ["resume"]},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "Embedding temporarily unavailable."
    assert "data" not in response.json()
