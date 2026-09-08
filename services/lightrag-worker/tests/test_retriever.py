import asyncio
import hashlib
from pathlib import Path

from lightrag import LightRAG
from lightrag.utils import EmbeddingFunc
import numpy as np

from lightrag_worker.retriever import (
    LightRAGHybridRetriever,
    LightRAGRuntimeBindings,
    create_lightrag_runtime_factory,
)
from lightrag_worker.types import EvidenceMetadata, EvidenceRecord, IndexManifest, IndexSnapshot


class FakeLightRAG:
    def __init__(self):
        self.inserted = []
        self.query_params = []
        self.generated_answer_calls = 0

    async def ainsert(self, texts, *, ids, file_paths):
        self.inserted.append((texts, ids, file_paths))

    async def aquery_data(self, query, param):
        self.query_params.append((query, param))
        return {
            "data": {
                "chunks": [
                    {"chunk_id": "chunk-a", "file_path": "evidence-a", "content": "Kubernetes experience"},
                    {"chunk_id": "chunk-unknown", "file_path": "unknown", "content": "untrusted"},
                ],
                "entities": [],
                "relationships": [
                    {"source_id": "chunk-a"},
                    {"source_id": "chunk-unknown"},
                    {"source_id": ""},
                ],
            }
        }

    async def aquery(self, *_args, **_kwargs):
        self.generated_answer_calls += 1
        raise AssertionError("generated answers must not be requested")


def snapshot() -> IndexSnapshot:
    text = "Kubernetes experience"
    record = EvidenceRecord(
        text=text,
        metadata=EvidenceMetadata(
            tenant_scope="tenant-a",
            document_id="resume-a",
            posting_id=None,
            profile_revision=3,
            page=2,
            block_id="skills",
            evidence_id="evidence-a",
            content_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            index_version="profile-r3",
        ),
    )
    return IndexSnapshot(
        index_name="profile_evidence",
        tenant_scope="tenant-a",
        index_version="profile-r3",
        manifest=IndexManifest(record_count=1, content_hash="a" * 64),
        records=(record,),
    )


def test_hybrid_retriever_uses_context_only_data_and_requires_source_evidence_ids():
    async def scenario():
        rag = FakeLightRAG()
        retriever = LightRAGHybridRetriever(runtime_factory=lambda _snapshot: rag)
        indexed = snapshot()

        await retriever.build(indexed)
        hits = await retriever.retrieve(indexed, "orchestration experience", 5)

        assert rag.inserted == [
            (["Kubernetes experience"], ["evidence-a"], ["evidence-a"])
        ]
        assert rag.query_params[0][0] == "orchestration experience"
        assert rag.query_params[0][1].mode == "hybrid"
        assert rag.query_params[0][1].only_need_context is True
        assert [hit.evidence_id for hit in hits] == ["evidence-a"]
        assert all(0 <= hit.score <= 1 for hit in hits)
        assert rag.generated_answer_calls == 0

    asyncio.run(scenario())


def test_runtime_factory_initializes_an_isolated_manifest_directory(tmp_path: Path):
    async def embed(texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def complete(_prompt: str, **_kwargs: object) -> str:
        return ""

    class FakeProductionLightRAG:
        def __init__(
            self,
            *,
            working_dir: str,
            auto_manage_storages_states: bool,
            embedding_func: EmbeddingFunc,
            llm_model_func: object,
            llm_model_name: str,
        ):
            self.working_dir = working_dir
            self.auto_manage_storages_states = auto_manage_storages_states
            self.embedding_func = embedding_func
            self.llm_model_func = llm_model_func
            self.llm_model_name = llm_model_name
            self.initialized = False

        async def initialize_storages(self):
            self.initialized = True

    async def scenario():
        indexed = snapshot()
        bindings = LightRAGRuntimeBindings(
            embedding_func=EmbeddingFunc(embedding_dim=3, func=embed),
            llm_model_func=complete,
            llm_model_name="offline-test-llm",
        )
        factory = create_lightrag_runtime_factory(
            tmp_path,
            bindings=bindings,
            constructor=FakeProductionLightRAG,
        )

        runtime = await factory(indexed)

        assert runtime.initialized is True
        assert runtime.auto_manage_storages_states is True
        assert runtime.embedding_func is bindings.embedding_func
        assert runtime.llm_model_func is complete
        assert runtime.llm_model_name == "offline-test-llm"
        assert Path(runtime.working_dir).is_relative_to(tmp_path.resolve())
        assert "tenant-a" not in runtime.working_dir
        assert "profile-r3" not in runtime.working_dir

    asyncio.run(scenario())


def test_real_runtime_factory_binds_injected_models_without_network(tmp_path: Path):
    async def embed(texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2, 0.3] for _ in texts]

    async def complete(_prompt: str, **_kwargs: object) -> str:
        return ""

    async def scenario():
        bindings = LightRAGRuntimeBindings(
            embedding_func=EmbeddingFunc(
                embedding_dim=3,
                func=embed,
                model_name="offline-test-embedding",
            ),
            llm_model_func=complete,
            llm_model_name="offline-test-llm",
        )
        factory = create_lightrag_runtime_factory(tmp_path, bindings=bindings)

        runtime = await factory(snapshot())

        assert isinstance(runtime, LightRAG)
        assert runtime.embedding_func is not None
        assert runtime.embedding_func.embedding_dim == 3
        assert runtime.embedding_func.model_name == "offline-test-embedding"
        assert runtime.llm_model_func is complete
        assert runtime.llm_model_name == "offline-test-llm"

    asyncio.run(scenario())


def test_real_runtime_indexes_with_injected_models_without_network(tmp_path: Path):
    calls = {"embedding": 0, "llm": 0}

    async def embed(texts: list[str]) -> np.ndarray:
        calls["embedding"] += 1
        return np.tile(np.asarray([[1.0, 0.0, 0.0]], dtype=np.float32), (len(texts), 1))

    async def complete(_prompt: str, **_kwargs: object) -> str:
        calls["llm"] += 1
        return ""

    async def scenario():
        bindings = LightRAGRuntimeBindings(
            embedding_func=EmbeddingFunc(embedding_dim=3, func=embed),
            llm_model_func=complete,
            llm_model_name="offline-test-llm",
        )
        retriever = LightRAGHybridRetriever(
            create_lightrag_runtime_factory(tmp_path, bindings=bindings),
        )

        await retriever.build(snapshot())

    asyncio.run(scenario())
    assert calls["embedding"] > 0
    assert calls["llm"] > 0
