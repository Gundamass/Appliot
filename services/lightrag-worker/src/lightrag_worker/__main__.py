from __future__ import annotations

import uvicorn

from .app import create_production_app
from .config import load_worker_settings


def main() -> None:
    settings = load_worker_settings()
    uvicorn.run(create_production_app(settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
