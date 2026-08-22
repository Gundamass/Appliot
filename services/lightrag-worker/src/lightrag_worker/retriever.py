from __future__ import annotations

import inspect
import hashlib
import json
import math
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .types import EvidenceRecord, IndexSnapshot, RetrievalHit


class LightRAGRuntime(Protocol):
    async def ainsert(self, texts: list[str], *, ids: list[str], file_paths: list[str]) -> object:
        ...

    async def aquery_data(self, query: str, param: object) -> object:
        ...


RuntimeFactory = Callable[[IndexSnapshot], LightRAGRuntime | Awaitable[LightRAGRuntime]]
RuntimeConstructor = Callable[..., LightRAGRuntime]
_SOURCE_SEPARATOR = re.compile(r"(?:<SEP>|[,;])")


@dataclass(frozen=True)
class LightRAGRuntimeBindings:
    embedding_func: Any
    llm_model_func: Callable[..., object]
    llm_model_name: str


class LightRAGHybridRetriever:
    """Uses LightRAG's structured, context-only API and discards generated output."""

    ready = True

    def __init__(self, runtime_factory: RuntimeFactory) -> None:
        self._runtime_factory = runtime_factory
        self._runtimes: dict[tuple[str, str, str, str], LightRAGRuntime] = {}

    async def build(self, snapshot: IndexSnapshot) -> None:
        runtime = self._runtime_factory(snapshot)
        if inspect.isawaitable(runtime):
            runtime = await runtime
        await runtime.ainsert(
            [record.text for record in snapshot.records],
            ids=[record.metadata.evidence_id for record in snapshot.records],
            file_paths=[record.metadata.evidence_id for record in snapshot.records],
        )
        self._runtimes[self._key(snapshot)] = runtime

    async def retrieve(self, snapshot: IndexSnapshot, query: str, top_k: int) -> Sequence[RetrievalHit]:
        runtime = self._runtimes.get(self._key(snapshot))
        if runtime is None:
            await self.build(snapshot)
            runtime = self._runtimes[self._key(snapshot)]
        from lightrag.base import QueryParam

        context = await runtime.aquery_data(query, QueryParam(
            mode="hybrid",
            only_need_context=True,
            top_k=top_k,
            chunk_top_k=top_k,
        ))
        return self._hits_from_context(context, snapshot.records, top_k)

    def _hits_from_context(
        self,
        context: object,
        records: tuple[EvidenceRecord, ...],
        top_k: int,
    ) -> list[RetrievalHit]:
        if not isinstance(context, Mapping):
            return []
        data = context.get("data")
        if not isinstance(data, Mapping):
            return []
        records_by_evidence = {record.metadata.evidence_id: record for record in records}
        chunk_sources: dict[str, str] = {}
        ranked: dict[str, float] = {}

        chunks = data.get("chunks")
        if isinstance(chunks, list):
            for position, chunk in enumerate(chunks):
                if not isinstance(chunk, Mapping):
                    continue
                evidence_id = self._evidence_id_for_source(chunk.get("file_path"), records_by_evidence)
                if evidence_id is None:
                    continue
                chunk_id = chunk.get("chunk_id")
                if isinstance(chunk_id, str) and chunk_id:
                    chunk_sources[chunk_id] = evidence_id
                self._record_score(ranked, evidence_id, 1 - position / max(len(chunks), 1))

        for group_name in ("entities", "relationships"):
            group = data.get(group_name)
            if not isinstance(group, list):
                continue
            for item in group:
                if not isinstance(item, Mapping):
                    continue
                for source_id in self._source_ids(item.get("source_id")):
                    evidence_id = chunk_sources.get(source_id)
                    if evidence_id is not None:
                        self._record_score(ranked, evidence_id, 0.5)

        return [
            RetrievalHit(evidence_id=evidence_id, score=score)
            for evidence_id, score in sorted(ranked.items(), key=lambda item: (-item[1], item[0]))[:top_k]
        ]

    @staticmethod
    def _key(snapshot: IndexSnapshot) -> tuple[str, str, str, str]:
        return (
            snapshot.index_name,
            snapshot.tenant_scope,
            snapshot.index_version,
            snapshot.manifest.content_hash,
        )

    @staticmethod
    def _evidence_id_for_source(source: object, records: dict[str, EvidenceRecord]) -> str | None:
        return source if isinstance(source, str) and source in records else None

    @staticmethod
    def _source_ids(value: object) -> list[str]:
        if isinstance(value, list):
            return [item for item in value if isinstance(item, str)]
        if not isinstance(value, str) or not value:
            return []
        return [item.strip() for item in _SOURCE_SEPARATOR.split(value) if item.strip()]

    @staticmethod
    def _record_score(ranked: dict[str, float], evidence_id: str, score: float) -> None:
        if math.isfinite(score) and 0 <= score <= 1:
            ranked[evidence_id] = max(ranked.get(evidence_id, 0), score)


def create_lightrag_runtime_factory(
    data_directory: Path,
    *,
    bindings: LightRAGRuntimeBindings,
    constructor: RuntimeConstructor | None = None,
) -> RuntimeFactory:
    root = data_directory.resolve()
    runtime_constructor = constructor if constructor is not None else _load_runtime_constructor()

    async def create(snapshot: IndexSnapshot) -> LightRAGRuntime:
        working_directory = _snapshot_directory(root, snapshot)
        working_directory.mkdir(parents=True, exist_ok=True)
        runtime = runtime_constructor(
            working_dir=str(working_directory),
            auto_manage_storages_states=True,
            embedding_func=bindings.embedding_func,
            llm_model_func=bindings.llm_model_func,
            llm_model_name=bindings.llm_model_name,
        )
        initialize = getattr(runtime, "initialize_storages", None)
        if not callable(initialize):
            raise RuntimeError("lightrag_runtime_invalid")
        initialized = initialize()
        if inspect.isawaitable(initialized):
            await initialized
        return runtime

    return create


def _load_runtime_constructor() -> RuntimeConstructor:
    from lightrag import LightRAG

    return LightRAG


def _snapshot_directory(root: Path, snapshot: IndexSnapshot) -> Path:
    identity = json.dumps({
        "indexName": snapshot.index_name,
        "tenantScope": snapshot.tenant_scope,
        "indexVersion": snapshot.index_version,
        "manifestHash": snapshot.manifest.content_hash,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return root / hashlib.sha256(identity).hexdigest()
