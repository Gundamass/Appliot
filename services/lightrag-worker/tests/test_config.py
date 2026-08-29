from pathlib import Path

import pytest

from lightrag_worker.config import OpenAICompatibleModelSettings, load_worker_settings


def test_worker_settings_require_a_token_and_keep_the_listener_local(tmp_path: Path):
    settings = load_worker_settings({
        "LIGHTRAG_WORKER_API_TOKEN": "worker-test-token",
        "LIGHTRAG_WORKER_DATA_DIR": str(tmp_path),
        "LIGHTRAG_WORKER_PORT": "43122",
    })

    assert settings.api_token == "worker-test-token"
    assert settings.data_directory == tmp_path.resolve()
    assert settings.host == "127.0.0.1"
    assert settings.port == 43122

    with pytest.raises(ValueError, match="worker_api_token_required"):
        load_worker_settings({})
    with pytest.raises(ValueError, match="worker_host_invalid"):
        load_worker_settings({"LIGHTRAG_WORKER_API_TOKEN": "worker-test-token", "LIGHTRAG_WORKER_HOST": "0.0.0.0"})
    with pytest.raises(ValueError, match="worker_port_invalid"):
        load_worker_settings({"LIGHTRAG_WORKER_API_TOKEN": "worker-test-token", "LIGHTRAG_WORKER_PORT": "65536"})


def test_worker_model_settings_are_explicit_complete_and_endpoint_validated():
    settings = load_worker_settings({
        "LIGHTRAG_WORKER_API_TOKEN": "worker-test-token",
        "LIGHTRAG_WORKER_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
        "LIGHTRAG_WORKER_LLM_API_TOKEN": "llm-test-token",
        "LIGHTRAG_WORKER_LLM_MODEL": "local-chat",
        "LIGHTRAG_WORKER_EMBEDDING_MODEL": "local-embedding",
        "LIGHTRAG_WORKER_EMBEDDING_DIMENSIONS": "1024",
    })

    assert settings.model == OpenAICompatibleModelSettings(
        llm_base_url="http://127.0.0.1:11434/v1",
        llm_api_token="llm-test-token",
        llm_model="local-chat",
        embedding_base_url="http://127.0.0.1:11434/v1",
        embedding_api_token="llm-test-token",
        embedding_model="local-embedding",
        embedding_dimensions=1024,
        timeout_seconds=30.0,
    )

    with pytest.raises(ValueError, match="worker_model_config_incomplete"):
        load_worker_settings({
            "LIGHTRAG_WORKER_API_TOKEN": "worker-test-token",
            "LIGHTRAG_WORKER_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
        })

    with pytest.raises(ValueError, match="worker_model_endpoint_invalid"):
        load_worker_settings({
            "LIGHTRAG_WORKER_API_TOKEN": "worker-test-token",
            "LIGHTRAG_WORKER_LLM_BASE_URL": "ftp://example.test/v1",
            "LIGHTRAG_WORKER_LLM_API_TOKEN": "llm-test-token",
            "LIGHTRAG_WORKER_LLM_MODEL": "local-chat",
            "LIGHTRAG_WORKER_EMBEDDING_MODEL": "local-embedding",
            "LIGHTRAG_WORKER_EMBEDDING_DIMENSIONS": "1024",
        })
