import asyncio
import json

import httpx
import numpy as np
import pytest

from lightrag_worker.config import OpenAICompatibleModelSettings
from lightrag_worker.model_bindings import create_openai_compatible_model_bindings


def settings() -> OpenAICompatibleModelSettings:
    return OpenAICompatibleModelSettings(
        llm_base_url="http://model.test/v1",
        llm_api_token="llm-test-token",
        llm_model="local-chat",
        embedding_base_url="http://model.test/v1",
        embedding_api_token="embedding-test-token",
        embedding_model="local-embedding",
        embedding_dimensions=3,
        timeout_seconds=12.0,
    )


def test_openai_compatible_bindings_use_explicit_endpoints_and_return_validated_results():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/v1/embeddings":
            return httpx.Response(200, json={
                "data": [{"index": 0, "embedding": [0.1, 0.2, 0.3]}]
            })
        if request.url.path == "/v1/chat/completions":
            return httpx.Response(200, json={
                "choices": [{"message": {"content": "entity extraction result"}}]
            })
        return httpx.Response(404)

    bindings = create_openai_compatible_model_bindings(
        settings(),
        transport=httpx.MockTransport(handler),
    )

    async def scenario():
        vectors = await bindings.embedding_func(["Kubernetes experience"])
        completion = await bindings.llm_model_func(
            "Extract entities.",
            system_prompt="Use the provided text only.",
        )
        return vectors, completion

    vectors, completion = asyncio.run(scenario())

    assert vectors.dtype == np.float32
    assert np.allclose(vectors, [[0.1, 0.2, 0.3]])
    assert completion == "entity extraction result"
    assert [request.url.path for request in requests] == [
        "/v1/embeddings",
        "/v1/chat/completions",
    ]
    assert requests[0].headers["Authorization"] == "Bearer embedding-test-token"
    assert requests[1].headers["Authorization"] == "Bearer llm-test-token"
    assert json.loads(requests[0].content) == {
        "model": "local-embedding",
        "input": ["Kubernetes experience"],
    }
    assert json.loads(requests[1].content)["messages"] == [
        {"role": "system", "content": "Use the provided text only."},
        {"role": "user", "content": "Extract entities."},
    ]


def test_openai_compatible_bindings_reject_invalid_embedding_responses():
    bindings = create_openai_compatible_model_bindings(
        settings(),
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "data": [{"index": 0, "embedding": [0.1, 0.2]}]
        })),
    )

    async def scenario():
        with pytest.raises(ValueError, match="embedding_response_invalid"):
            await bindings.embedding_func(["Kubernetes experience"])

    asyncio.run(scenario())


def test_openai_compatible_bindings_reject_embeddings_that_overflow_float32():
    bindings = create_openai_compatible_model_bindings(
        settings(),
        transport=httpx.MockTransport(lambda _request: httpx.Response(200, json={
            "data": [{"index": 0, "embedding": [1e100, 0.2, 0.3]}]
        })),
    )

    async def scenario():
        with pytest.raises(ValueError, match="embedding_response_invalid"):
            await bindings.embedding_func(["Kubernetes experience"])

    asyncio.run(scenario())
