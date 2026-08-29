import asyncio
import hashlib
import json

import pytest

from lightrag_worker.index_manager import (
    IndexManager,
    RetrievalScopeMismatchError,
)
from lightrag_worker.types import (
    DeleteRequest,
    EvidenceMetadata,
    EvidenceQuery,
    EvidenceRecord,
    IndexManifest,
    RetrievalHit,
    UpsertRequest,
)


class FakeContextRetriever:
    ready = True

    def __init__(self, hits: list[RetrievalHit]):
        self.hits = hits
        self.builds = []

    async def build(self, snapshot):
        self.builds.append(snapshot)

    async def retrieve(self, snapshot, query: str, top_k: int):
        return self.hits[:top_k]


def record(
    evidence_id: str,
    *,
    tenant_scope: str = "tenant-a",
    index_version: str = "profile-r3",
    profile_revision: int | None = 3,
    posting_id: str | None = None,
) -> EvidenceRecord:
    text = f"verified evidence for {evidence_id}"
    return EvidenceRecord(
        text=text,
        metadata=EvidenceMetadata(
            tenant_scope=tenant_scope,
            document_id=f"document-{evidence_id}",
            posting_id=posting_id,
            profile_revision=profile_revision,
            page=1,
            block_id=f"block-{evidence_id}",
            evidence_id=evidence_id,
            content_hash=hashlib.sha256(text.encode("utf-8")).hexdigest(),
            index_version=index_version,
        ),
    )


def manifest(records: list[EvidenceRecord]) -> IndexManifest:
    payload = [
        {
            "evidenceId": item.metadata.evidence_id,
            "contentHash": item.metadata.content_hash,
            "indexVersion": item.metadata.index_version,
        }
        for item in sorted(records, key=lambda item: item.metadata.evidence_id)
    ]
    return IndexManifest(
        record_count=len(records),
        content_hash=hashlib.sha256(
            json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        ).hexdigest(),
    )


def upsert_request(
    records: list[EvidenceRecord],
    *,
    index_name: str = "profile_evidence",
    tenant_scope: str = "tenant-a",
    index_version: str = "profile-r3",
) -> UpsertRequest:
    return UpsertRequest(
        index_name=index_name,
        tenant_scope=tenant_scope,
        index_version=index_version,
        manifest=manifest(records),
        records=tuple(records),
    )


def test_profile_retrieval_never_leaks_another_tenant_or_revision():
    async def scenario():
        visible = record("profile-a")
        foreign_tenant = record("profile-b", tenant_scope="tenant-b")
        foreign_revision = record("profile-c", index_version="profile-r4", profile_revision=4)
        retriever = FakeContextRetriever([
            RetrievalHit(evidence_id="profile-a", score=0.98),
            RetrievalHit(evidence_id="profile-b", score=0.97),
            RetrievalHit(evidence_id="profile-c", score=0.96),
            RetrievalHit(evidence_id="unknown", score=0.95),
        ])
        manager = IndexManager(retriever)
        await manager.upsert(upsert_request([visible]))
        await manager.upsert(upsert_request([foreign_tenant], tenant_scope="tenant-b"))
        await manager.upsert(upsert_request([foreign_revision], index_version="profile-r4"))

        result = await manager.retrieve(EvidenceQuery(
            query="distributed systems",
            scope="profile",
            tenant_scope="tenant-a",
            profile_revision=3,
            top_k=5,
        ))

        assert [item.evidence_id for item in result.evidence] == ["profile-a"]
        assert result.retrieval_version == "profile-r3"
        with pytest.raises(RetrievalScopeMismatchError, match="retrieval_scope_mismatch"):
            await manager.retrieve(EvidenceQuery(
                query="distributed systems",
                scope="profile",
                tenant_scope="tenant-a",
                profile_revision=2,
                top_k=5,
            ))

    asyncio.run(scenario())


def test_upsert_and_delete_are_idempotent_and_keep_retired_versions_for_replay():
    async def scenario():
        profile_r3 = record("profile-a")
        profile_r4 = record("profile-d", index_version="profile-r4", profile_revision=4)
        retriever = FakeContextRetriever([RetrievalHit(evidence_id="profile-a", score=0.9)])
        manager = IndexManager(retriever, retained_versions=2)

        first = upsert_request([profile_r3])
        assert await manager.upsert(first) == first.manifest
        assert await manager.upsert(first) == first.manifest
        assert len(retriever.builds) == 1

        second = upsert_request([profile_r4], index_version="profile-r4")
        await manager.upsert(second)
        replay = await manager.retrieve(EvidenceQuery(
            query="python",
            scope="profile",
            tenant_scope="tenant-a",
            profile_revision=3,
            index_version="profile-r3",
            top_k=3,
        ))
        assert replay.retrieval_version == "profile-r3"
        assert [item.evidence_id for item in replay.evidence] == ["profile-a"]

        empty = upsert_request([], index_version="profile-r4")
        deleted = await manager.delete(DeleteRequest(
            index_name="profile_evidence",
            tenant_scope="tenant-a",
            index_version="profile-r4",
            evidence_ids=("profile-d",),
            manifest=empty.manifest,
        ))
        assert deleted == empty.manifest
        assert await manager.delete(DeleteRequest(
            index_name="profile_evidence",
            tenant_scope="tenant-a",
            index_version="profile-r4",
            evidence_ids=("profile-d",),
            manifest=empty.manifest,
        )) == empty.manifest
        assert len(retriever.builds) == 3

    asyncio.run(scenario())


def test_rejects_manifest_or_metadata_that_cannot_be_safely_indexed():
    async def scenario():
        unsafe = record("unsafe")
        unsafe = EvidenceRecord(
            text="<html><body>raw ATS page</body></html>",
            metadata=unsafe.metadata,
        )
        manager = IndexManager(FakeContextRetriever([]))

        with pytest.raises(ValueError, match="index_record_invalid"):
            await manager.upsert(upsert_request([unsafe]))

        valid = record("valid")
        with pytest.raises(ValueError, match="index_manifest_mismatch"):
            await manager.upsert(UpsertRequest(
                index_name="profile_evidence",
                tenant_scope="tenant-a",
                index_version="profile-r3",
                manifest=IndexManifest(record_count=1, content_hash="0" * 64),
                records=(valid,),
            ))

    asyncio.run(scenario())

