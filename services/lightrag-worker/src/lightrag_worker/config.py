from __future__ import annotations

import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse


@dataclass(frozen=True)
class OpenAICompatibleModelSettings:
    llm_base_url: str
    llm_api_token: str = field(repr=False)
    llm_model: str
    embedding_base_url: str
    embedding_api_token: str = field(repr=False)
    embedding_model: str
    embedding_dimensions: int
    timeout_seconds: float


@dataclass(frozen=True)
class WorkerSettings:
    api_token: str
    data_directory: Path = Path("data/lightrag-worker")
    host: str = "127.0.0.1"
    port: int = 43122
    model: OpenAICompatibleModelSettings | None = None


def load_worker_settings(env: Mapping[str, str] | None = None) -> WorkerSettings:
    values = os.environ if env is None else env
    api_token = values.get("LIGHTRAG_WORKER_API_TOKEN", "")
    if not isinstance(api_token, str) or not api_token.strip():
        raise ValueError("worker_api_token_required")

    host = values.get("LIGHTRAG_WORKER_HOST", "127.0.0.1")
    if host != "127.0.0.1":
        raise ValueError("worker_host_invalid")

    raw_port = values.get("LIGHTRAG_WORKER_PORT", "43122")
    try:
        port = int(raw_port)
    except (TypeError, ValueError):
        raise ValueError("worker_port_invalid") from None
    if isinstance(raw_port, bool) or not 1 <= port <= 65_535:
        raise ValueError("worker_port_invalid")

    raw_directory = values.get("LIGHTRAG_WORKER_DATA_DIR", "data/lightrag-worker")
    if not isinstance(raw_directory, str) or not raw_directory.strip():
        raise ValueError("worker_data_directory_invalid")
    return WorkerSettings(
        api_token=api_token,
        data_directory=Path(raw_directory).expanduser().resolve(),
        host=host,
        port=port,
        model=_load_model_settings(values),
    )


def _load_model_settings(values: Mapping[str, str]) -> OpenAICompatibleModelSettings | None:
    names = (
        "LIGHTRAG_WORKER_LLM_BASE_URL",
        "LIGHTRAG_WORKER_LLM_API_TOKEN",
        "LIGHTRAG_WORKER_LLM_MODEL",
        "LIGHTRAG_WORKER_EMBEDDING_BASE_URL",
        "LIGHTRAG_WORKER_EMBEDDING_API_TOKEN",
        "LIGHTRAG_WORKER_EMBEDDING_MODEL",
        "LIGHTRAG_WORKER_EMBEDDING_DIMENSIONS",
        "LIGHTRAG_WORKER_MODEL_TIMEOUT_SECONDS",
    )
    configured = {name: values.get(name) for name in names}
    if all(value is None or not str(value).strip() for value in configured.values()):
        return None

    llm_base_url = _required(configured, "LIGHTRAG_WORKER_LLM_BASE_URL")
    llm_api_token = _required(configured, "LIGHTRAG_WORKER_LLM_API_TOKEN")
    llm_model = _required(configured, "LIGHTRAG_WORKER_LLM_MODEL")
    embedding_model = _required(configured, "LIGHTRAG_WORKER_EMBEDDING_MODEL")
    raw_dimensions = _required(configured, "LIGHTRAG_WORKER_EMBEDDING_DIMENSIONS")
    embedding_base_url = _optional(configured, "LIGHTRAG_WORKER_EMBEDDING_BASE_URL") or llm_base_url
    embedding_api_token = _optional(configured, "LIGHTRAG_WORKER_EMBEDDING_API_TOKEN") or llm_api_token
    timeout_seconds = _optional(configured, "LIGHTRAG_WORKER_MODEL_TIMEOUT_SECONDS") or "30"

    try:
        embedding_dimensions = int(raw_dimensions)
    except ValueError:
        raise ValueError("worker_model_dimensions_invalid") from None
    if not 1 <= embedding_dimensions <= 8_192:
        raise ValueError("worker_model_dimensions_invalid")

    try:
        timeout = float(timeout_seconds)
    except ValueError:
        raise ValueError("worker_model_timeout_invalid") from None
    if not math.isfinite(timeout) or not 0 < timeout <= 120:
        raise ValueError("worker_model_timeout_invalid")

    return OpenAICompatibleModelSettings(
        llm_base_url=_endpoint(llm_base_url),
        llm_api_token=_model_value(llm_api_token),
        llm_model=_model_value(llm_model),
        embedding_base_url=_endpoint(embedding_base_url),
        embedding_api_token=_model_value(embedding_api_token),
        embedding_model=_model_value(embedding_model),
        embedding_dimensions=embedding_dimensions,
        timeout_seconds=timeout,
    )


def _required(values: Mapping[str, str | None], name: str) -> str:
    value = _optional(values, name)
    if value is None:
        raise ValueError("worker_model_config_incomplete")
    return value


def _optional(values: Mapping[str, str | None], name: str) -> str | None:
    value = values.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("worker_model_config_incomplete")
    normalized = value.strip()
    return normalized or None


def _endpoint(value: str) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("worker_model_endpoint_invalid")
    return value.rstrip("/")


def _model_value(value: str) -> str:
    if len(value) > 200 or "\x00" in value or "\n" in value or "\r" in value:
        raise ValueError("worker_model_config_invalid")
    return value
