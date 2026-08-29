import os


os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import uvicorn

from .app import create_app
from .backend_factory import create_backend
from .config import load_settings


def main() -> None:
    settings = load_settings()
    backend = create_backend(settings)
    application = create_app(backend, settings)
    uvicorn.run(application, host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
