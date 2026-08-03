import base64
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .config import OfflineOcrSettings


os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

PROMPT = "<image>\n<|grounding|>Convert the document to markdown."
_WARMUP_IMAGE = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGP8//8/AzbAhFV00EoAAFbUAw037MyjAAAAAElFTkSuQmCC"
)
AutoTokenizer = None
AutoModel = None
torch = None


class OcrInferenceError(RuntimeError):
    """The pinned model did not return usable Markdown."""


class DeepSeekOcrBackend:
    model: str
    revision: str

    def __init__(
        self,
        settings: OfflineOcrSettings,
        *,
        auto_tokenizer_cls: Any = None,
        auto_model_cls: Any = None,
        torch_module: Any = None,
    ) -> None:
        tokenizer_cls, model_cls, torch_runtime = _runtime_dependencies(
            auto_tokenizer_cls,
            auto_model_cls,
            torch_module,
        )
        self.model = settings.model
        self.revision = settings.revision
        self._temp_dir = settings.temp_dir
        self._ready = False
        self._tokenizer = tokenizer_cls.from_pretrained(
            settings.model_path,
            trust_remote_code=True,
            local_files_only=True,
        )
        self._model = (
            model_cls.from_pretrained(
                settings.model_path,
                trust_remote_code=True,
                local_files_only=True,
                use_safetensors=True,
                _attn_implementation="flash_attention_2",
            )
            .eval()
            .cuda()
            .to(torch_runtime.bfloat16)
        )
        self.recognize(_WARMUP_IMAGE)
        self._ready = True

    @property
    def ready(self) -> bool:
        return self._ready

    def recognize(self, image_bytes: bytes) -> str:
        with TemporaryDirectory(dir=self._temp_dir, prefix="ocr-") as directory:
            request_dir = Path(directory)
            image_path = request_dir / f"input{_image_suffix(image_bytes)}"
            output_dir = request_dir / "output"
            output_dir.mkdir()
            image_path.write_bytes(image_bytes)
            result = self._model.infer(
                self._tokenizer,
                prompt=PROMPT,
                image_file=str(image_path),
                output_path=str(output_dir),
                base_size=1024,
                image_size=768,
                crop_mode=True,
                save_results=False,
                eval_mode=True,
            )
            return _markdown_result(result, output_dir)


def _runtime_dependencies(
    auto_tokenizer_cls: Any,
    auto_model_cls: Any,
    torch_module: Any,
) -> tuple[Any, Any, Any]:
    tokenizer_cls = auto_tokenizer_cls
    model_cls = auto_model_cls
    if tokenizer_cls is None or model_cls is None:
        global AutoModel, AutoTokenizer
        if AutoTokenizer is None or AutoModel is None:
            from transformers import AutoModel as imported_auto_model
            from transformers import AutoTokenizer as imported_auto_tokenizer

            AutoTokenizer = imported_auto_tokenizer
            AutoModel = imported_auto_model
        tokenizer_cls = AutoTokenizer if tokenizer_cls is None else tokenizer_cls
        model_cls = AutoModel if model_cls is None else model_cls
    torch_runtime = torch_module
    if torch_runtime is None:
        global torch
        if torch is None:
            import torch as imported_torch

            torch = imported_torch
        torch_runtime = torch
    if tokenizer_cls is None or model_cls is None or torch_runtime is None:
        raise RuntimeError("transformers and torch are required to load the offline OCR backend.")
    return tokenizer_cls, model_cls, torch_runtime


def _image_suffix(image_bytes: bytes) -> str:
    return ".jpg" if image_bytes.startswith(b"\xff\xd8") else ".png"


def _markdown_result(result: object, output_dir: Path) -> str:
    output_files = [path for path in output_dir.rglob("*") if path.is_file()]
    returned_text = _normalize_markdown(result) if isinstance(result, str) else ""
    if returned_text and output_files:
        raise OcrInferenceError("OCR inference produced ambiguous returned text and generated files.")
    if returned_text:
        return returned_text
    if not output_files:
        raise OcrInferenceError("OCR inference returned empty Markdown and no generated result file.")
    if len(output_files) > 1:
        raise OcrInferenceError("OCR inference generated multiple result files.")
    try:
        text = output_files[0].read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        raise OcrInferenceError("OCR inference generated an unreadable result file.") from error
    normalized = _normalize_markdown(text)
    if not normalized:
        raise OcrInferenceError("OCR inference returned empty Markdown.")
    return normalized


def _normalize_markdown(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").strip()
