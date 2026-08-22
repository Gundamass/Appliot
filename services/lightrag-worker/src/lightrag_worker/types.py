from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, Sequence


IndexName = Literal["profile_evidence", "job_requirements"]
RetrievalScope = Literal["profile", "job"]


@dataclass(frozen=True)
class EvidenceMetadata:
    tenant_scope: str
    document_id: str
    posting_id: str | None
    profile_revision: int | None
    page: int | None
    block_id: str | None
    evidence_id: str
    content_hash: str
    index_version: str


@dataclass(frozen=True)
class EvidenceRecord:
    text: str
    metadata: EvidenceMetadata


@dataclass(frozen=True)
class IndexManifest:
    record_count: int
    content_hash: str


@dataclass(frozen=True)
class IndexSnapshot:
    index_name: IndexName
    tenant_scope: str
    index_version: str
    manifest: IndexManifest
    records: tuple[EvidenceRecord, ...]


@dataclass(frozen=True)
class UpsertRequest:
    index_name: IndexName
    tenant_scope: str
    index_version: str
    manifest: IndexManifest
    records: tuple[EvidenceRecord, ...]


@dataclass(frozen=True)
class DeleteRequest:
    index_name: IndexName
    tenant_scope: str
    index_version: str
    evidence_ids: tuple[str, ...]
    manifest: IndexManifest


@dataclass(frozen=True)
class EvidenceQuery:
    query: str
    scope: RetrievalScope
    tenant_scope: str
    top_k: int
    profile_revision: int | None = None
    posting_id: str | None = None
    index_version: str | None = None


@dataclass(frozen=True)
class RetrievalHit:
    evidence_id: str
    score: float


@dataclass(frozen=True)
class EvidenceReference:
    evidence_id: str
    document_id: str
    posting_id: str | None
    page: int | None
    block_id: str | None
    quote_hash: str
    score: float


@dataclass(frozen=True)
class RetrievalResult:
    retrieval_version: str
    evidence: tuple[EvidenceReference, ...]


class ContextRetriever(Protocol):
    ready: bool

    async def build(self, snapshot: IndexSnapshot) -> None:
        ...

    async def retrieve(
        self,
        snapshot: IndexSnapshot,
        query: str,
        top_k: int,
    ) -> Sequence[RetrievalHit]:
        ...
