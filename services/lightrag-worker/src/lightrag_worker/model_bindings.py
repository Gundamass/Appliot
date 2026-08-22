from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx
import numpy as np
from lightrag.utils import EmbeddingFunc

from .config import OpenAICompatibleModelSettings
from .retriever import LightRAGRuntimeBindings


@dataclass(frozen=True)
class _OpenAICompatibleProvider:
    settings: OpenAICompatibleModelSettings
    transport: httpx.AsyncBaseTransport | None = None

    async def embed(self, texts: Sequence[str], **_kwargs: object) -> np.ndarray:
        inputs = self._texts(texts, "embedding_request_invalid")
        payload = await self._post(
            self.settings.embedding_base_url,
            self.settings.embedding_api_token,
            "/embeddings",
            {"model": self.settings.embedding_model, "input": inputs},
        )
        return self._embeddings(payload, len(inputs))

    async def complete(
        self,
        prompt: str,
        system_prompt: str | None = None,
        history_messages: Sequence[Mapping[str, object]] | None = None,
        **kwargs: object,
    ) -> str:
        if not isinstance(prompt, str) or not prompt:
            raise ValueError("llm_request_invalid")
        messages: list[dict[str, str]] = []
        if system_prompt is not None:
            if not isinstance(system_prompt, str) or not system_prompt:
                raise ValueError("llm_request_invalid")
            messages.append({"role": "system", "content": system_prompt})
        if history_messages is not None:
            for message in history_messages:
                if not isinstance(message, Mapping):
                    raise ValueError("llm_request_invalid")
                role = message.get("role")
                content = message.get("content")
                if role not in {"system", "user", "assistant"} or not isinstance(content, str) or not content:
                    raise ValueError("llm_request_invalid")
                messages.append({"role": role, "content": content})
        messages.append({"role": "user", "content": prompt})

        request: dict[str, object] = {
            "model": self.settings.llm_model,
            "messages": messages,
            "temperature": 0,
        }
        max_tokens = kwargs.get("max_tokens")
        if isinstance(max_tokens, int) and not isinstance(max_tokens, bool) and max_tokens > 0:
            request["max_tokens"] = max_tokens
        payload = await self._post(
            self.settings.llm_base_url,
            self.settings.llm_api_token,
            "/chat/completions",
            request,
        )
        return self._completion(payload)

    async def _post(
        self,
        base_url: str,
        api_token: str,
        path: str,
        body: dict[str, object],
    ) -> object:
        try:
            async with httpx.AsyncClient(
                timeout=self.settings.timeout_seconds,
                transport=self.transport,
            ) as client:
                response = await client.post(
                    f"{base_url}{path}",
                    headers={"Authorization": f"Bearer {api_token}"},
                    json=body,
                )
                response.raise_for_status()
        except httpx.HTTPError as error:
            raise RuntimeError("lightrag_model_unavailable") from error
        try:
            return response.json()
        except ValueError as error:
            raise ValueError("model_response_invalid") from error

    def _embeddings(self, payload: object, expected_count: int) -> np.ndarray:
        if not isinstance(payload, Mapping):
            raise ValueError("embedding_response_invalid")
        data = payload.get("data")
        if not isinstance(data, list) or len(data) != expected_count:
            raise ValueError("embedding_response_invalid")

        rows: list[list[float]] = []
        for index, item in enumerate(data):
            if not isinstance(item, Mapping) or item.get("index") != index:
                raise ValueError("embedding_response_invalid")
            embedding = item.get("embedding")
            if (
                not isinstance(embedding, list)
                or len(embedding) != self.settings.embedding_dimensions
                or any(
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(value)
                    for value in embedding
                )
            ):
                raise ValueError("embedding_response_invalid")
            rows.append([float(value) for value in embedding])
        with np.errstate(over="ignore"):
            vectors = np.asarray(rows, dtype=np.float32)
        if not np.isfinite(vectors).all():
            raise ValueError("embedding_response_invalid")
        return vectors

    @staticmethod
    def _completion(payload: object) -> str:
        if not isinstance(payload, Mapping):
            raise ValueError("llm_response_invalid")
        choices = payload.get("choices")
        if not isinstance(choices, list) or not choices:
            raise ValueError("llm_response_invalid")
        first = choices[0]
        if not isinstance(first, Mapping):
            raise ValueError("llm_response_invalid")
        message = first.get("message")
        if not isinstance(message, Mapping):
            raise ValueError("llm_response_invalid")
        content = message.get("content")
        if not isinstance(content, str) or not content:
            raise ValueError("llm_response_invalid")
        return content

    @staticmethod
    def _texts(value: Sequence[str], code: str) -> list[str]:
        if isinstance(value, (str, bytes)) or not isinstance(value, Sequence) or not value:
            raise ValueError(code)
        texts = list(value)
        if any(not isinstance(text, str) or not text for text in texts):
            raise ValueError(code)
        return texts


def create_openai_compatible_model_bindings(
    settings: OpenAICompatibleModelSettings,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> LightRAGRuntimeBindings:
    provider = _OpenAICompatibleProvider(settings=settings, transport=transport)
    return LightRAGRuntimeBindings(
        embedding_func=EmbeddingFunc(
            embedding_dim=settings.embedding_dimensions,
            func=provider.embed,
            model_name=settings.embedding_model,
        ),
        llm_model_func=provider.complete,
        llm_model_name=settings.llm_model,
    )
