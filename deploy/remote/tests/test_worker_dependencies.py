import sys
import unittest
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - deployment tests run with modern local Python.
    tomllib = None


ROOT = Path(__file__).parents[3]


class WorkerDependencyTests(unittest.TestCase):
    @unittest.skipIf(tomllib is None, "tomllib requires Python 3.11+")
    def test_embedding_declares_supervisor_fallback(self) -> None:
        dependencies = self._dependencies("embedding-worker")
        self.assertIn("supervisor==4.2.5", dependencies)
        self.assertIn("setuptools==80.9.0", dependencies)

    @unittest.skipIf(tomllib is None, "tomllib requires Python 3.11+")
    def test_embedding_pins_python_310_compatible_pillow(self) -> None:
        dependencies = self._dependencies("embedding-worker")
        self.assertIn("Pillow==11.2.1", dependencies)

    @unittest.skipIf(tomllib is None, "tomllib requires Python 3.11+")
    def test_ocr_declares_pinned_model_runtime(self) -> None:
        dependencies = self._dependencies("ocr-worker")
        expected = {
            "torch==2.6.0+cu118",
            "torchvision==0.21.0+cu118",
            "transformers==4.46.3",
            "flash-attn==2.7.3",
            "addict==2.4.0",
            "einops==0.8.1",
            "easydict==1.13",
            "requests==2.32.5",
            "tqdm==4.67.1",
            "numpy==2.2.6",
        }
        self.assertTrue(expected.issubset(set(dependencies)))

    def _dependencies(self, worker: str):
        path = ROOT / "services" / worker / "pyproject.toml"
        with path.open("rb") as handle:
            value = tomllib.load(handle)
        return value["project"]["dependencies"]


if __name__ == "__main__":
    unittest.main()
