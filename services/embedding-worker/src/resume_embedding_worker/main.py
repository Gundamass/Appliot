import os

import uvicorn

from .app import create_app
from .config import load_settings
from .types import DEFAULT_HOST, DEFAULT_PORT


def main() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    from .model import QwenEmbeddingBackend

    settings = load_settings()
    backend = QwenEmbeddingBackend(settings)
    application = create_app(backend, settings)
    uvicorn.run(application, host=DEFAULT_HOST, port=DEFAULT_PORT)


if __name__ == "__main__":
    main()
