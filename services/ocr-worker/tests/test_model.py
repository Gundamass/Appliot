import asyncio
from pathlib import Path

import pytest

from resume_ocr_worker.model import DeepSeekOcrBackend, OcrInferenceError, PROMPT


class FakeTorch:
    bfloat16 = object()


class FakeTokenizer:
    calls = []

    @classmethod
    def from_pretrained(cls, model_path, **kwargs):
        cls.calls.append((model_path, kwargs))
        return "tokenizer"


class FakeModel:
    instances = []
    result = "# Resume\nAda Lovelace"
    error: BaseException | None = None
    output_files: dict[str, bytes | str] = {}

    def __init__(self):
        self.infer_calls = []
        self.__class__.instances.append(self)

    def eval(self):
        return self

    def cuda(self):
        return self

    def to(self, dtype):
        self.dtype = dtype
        return self

    def infer(self, tokenizer, **kwargs):
        self.infer_calls.append((tokenizer, kwargs))
        if self.error is not None:
            raise self.error
        output_dir = Path(kwargs["output_path"])
        for relative_path, contents in self.output_files.items():
            output_file = output_dir / relative_path
            output_file.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(contents, bytes):
                output_file.write_bytes(contents)
            else:
                output_file.write_text(contents, encoding="utf-8")
        return self.result


class FakeAutoModel:
    calls = []

    @classmethod
    def from_pretrained(cls, model_path, **kwargs):
        cls.calls.append((model_path, kwargs))
        return FakeModel()


class Settings:
    model_path = Path("/offline/model")
    model = "deepseek-ai/DeepSeek-OCR-2"
    revision = "aaa02f3811945a91062062994c5c4a3f4c0af2b0"

    def __init__(self, temp_dir: Path):
        self.temp_dir = temp_dir


@pytest.fixture(autouse=True)
def clear_fakes():
    FakeTokenizer.calls.clear()
    FakeAutoModel.calls.clear()
    FakeModel.instances.clear()
    FakeModel.result = "# Resume\nAda Lovelace"
    FakeModel.error = None
    FakeModel.output_files = {}


def backend(tmp_path: Path) -> DeepSeekOcrBackend:
    return DeepSeekOcrBackend(
        Settings(tmp_path),
        auto_tokenizer_cls=FakeTokenizer,
        auto_model_cls=FakeAutoModel,
        torch_module=FakeTorch,
    )


def test_backend_loads_pinned_local_snapshot_with_bf16_flash_attention_and_warmup(tmp_path: Path):
    instance = backend(tmp_path)

    assert instance.ready is True
    assert FakeTokenizer.calls == [(Settings.model_path, {"trust_remote_code": True, "local_files_only": True})]
    assert FakeAutoModel.calls == [
        (
            Settings.model_path,
            {
                "trust_remote_code": True,
                "local_files_only": True,
                "use_safetensors": True,
                "_attn_implementation": "flash_attention_2",
            },
        )
    ]
    assert FakeModel.instances[0].dtype is FakeTorch.bfloat16
    assert len(FakeModel.instances[0].infer_calls) == 1
    assert list(tmp_path.iterdir()) == []


def test_backend_passes_exact_document_prompt_and_cleans_temporary_files(tmp_path: Path):
    instance = backend(tmp_path)

    result = instance.recognize(b"\x89PNG\r\n\x1a\ninput")

    assert result == "# Resume\nAda Lovelace"
    _, call = FakeModel.instances[0].infer_calls[-1]
    assert call["prompt"] == PROMPT == "<image>\n<|grounding|>Convert the document to markdown."
    assert Path(call["image_file"]).suffix == ".png"
    assert Path(call["output_path"]).name == "output"
    assert call["base_size"] == 1024
    assert call["image_size"] == 768
    assert call["crop_mode"] is True
    assert call["save_results"] is True
    assert list(tmp_path.iterdir()) == []


def test_backend_reads_single_generated_markdown_file_when_custom_code_returns_blank(tmp_path: Path):
    class FileModel(FakeModel):
        def infer(self, tokenizer, **kwargs):
            super().infer(tokenizer, **kwargs)
            output = Path(kwargs["output_path"])
            output.mkdir(exist_ok=True)
            (output / "result.md").write_text("# From file\r\n", encoding="utf-8")
            return " "

    class FileAutoModel(FakeAutoModel):
        @classmethod
        def from_pretrained(cls, model_path, **kwargs):
            cls.calls.append((model_path, kwargs))
            return FileModel()

    instance = DeepSeekOcrBackend(
        Settings(tmp_path),
        auto_tokenizer_cls=FakeTokenizer,
        auto_model_cls=FileAutoModel,
        torch_module=FakeTorch,
    )

    assert instance.recognize(b"jpeg") == "# From file"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("error", [RuntimeError("model failed"), asyncio.CancelledError()])
def test_backend_cleans_temporary_files_when_inference_fails(tmp_path: Path, error: BaseException):
    instance = backend(tmp_path)
    FakeModel.error = error

    with pytest.raises(type(error)):
        instance.recognize(b"input")

    assert list(tmp_path.iterdir()) == []


def test_backend_rejects_blank_result_without_leftover_files(tmp_path: Path):
    instance = backend(tmp_path)
    FakeModel.result = " \n\t"

    with pytest.raises(OcrInferenceError, match="empty"):
        instance.recognize(b"input")

    assert list(tmp_path.iterdir()) == []


def test_backend_rejects_returned_text_together_with_generated_output_file_and_cleans_up(tmp_path: Path):
    instance = backend(tmp_path)
    FakeModel.result = "# Returned text"
    FakeModel.output_files = {"result.md": "# File text"}

    with pytest.raises(OcrInferenceError, match="ambiguous"):
        instance.recognize(b"input")

    assert list(tmp_path.iterdir()) == []


def test_backend_rejects_multiple_generated_output_files_and_cleans_up(tmp_path: Path):
    instance = backend(tmp_path)
    FakeModel.result = " "
    FakeModel.output_files = {"first.md": "# First", "nested/second.md": "# Second"}

    with pytest.raises(OcrInferenceError, match="multiple"):
        instance.recognize(b"input")

    assert list(tmp_path.iterdir()) == []
