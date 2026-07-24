import os


os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import uvicorn

from .app import create_app
from .config import load_settings


def main() -> None:
    settings = load_settings()
    from .model import DeepSeekOcrBackend

    backend = DeepSeekOcrBackend(settings)
    application = create_app(backend, settings)
    uvicorn.run(application, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
