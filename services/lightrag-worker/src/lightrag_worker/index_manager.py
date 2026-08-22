from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from collections import defaultdict
from dataclasses import dataclass

from .types import (
    ContextRetriever,
    DeleteRequest,
    EvidenceQuery,
    EvidenceRecord,
    EvidenceReference,
    IndexManifest,
    IndexName,
    IndexSnapshot,
    RetrievalHit,
    RetrievalResult,
    UpsertRequest,
)


MAX_QUERY_LENGTH = 2_000
MAX_RESULT_COUNT = 20
MAX_RECORD_TEXT_LENGTH = 6_000
_HASH = re.compile(r"^[0-9a-f]{64}$")
_HTML = re.compile(r"<\s*/?\s*(?:html|head|body|script|style|form|div|table)\b", re.IGNORECASE)
_CREDENTIAL = re.compile(r"(?:authorization\s*:|bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key\s*[=:])", re.IGNORECASE)
_SPACE = re.compile(r"\s+")


class IndexVersionNotFoundError(ValueError):
    def __init__(self) -> None:
        super().__init__("retrieval_index_missing")


class RetrievalScopeMismatchError(ValueError):
    def __init__(self) -> None:
        super().__init__("retrieval_scope_mismatch")


@dataclass(frozen=True)
class IndexHealth:
    ready: bool
    active_indexes: int
    retired_indexes: int


class IndexManager:
    """Owns versioned index promotion and rechecks all retrieval boundaries."""

    def __init__(self, retriever: ContextRetriever, retained_versions: int = 2) -> None:
        if retained_versions < 1:
            raise ValueError("retained_versions_invalid")
        self._retriever = retriever
        self._retained_versions = retained_versions
        self._active: dict[tuple[IndexName, str], IndexSnapshot] = {}
        self._retired: dict[tuple[IndexName, str], list[IndexSnapshot]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def upsert(self, request: UpsertRequest) -> IndexManifest:
        self._validate_upsert(request)
        key = (request.index_name, request.tenant_scope)
        async with self._lock:
            active = self._active.get(key)
            records = (
                {record.metadata.evidence_id: record for record in active.records}
                if active is not None and active.index_version == request.index_version
                else {}
            )
            records.update({record.metadata.evidence_id: record for record in request.records})
            proposed = self._snapshot(request.index_name, request.tenant_scope, request.index_version, records.values())
            self._assert_manifest(request.manifest, proposed.manifest)
            if active == proposed:
                return active.manifest
            await self._retriever.build(proposed)
            self._promote(key, proposed)
            return proposed.manifest

    async def delete(self, request: DeleteRequest) -> IndexManifest:
        self._validate_delete(request)
        key = (request.index_name, request.tenant_scope)
        async with self._lock:
            active = self._active.get(key)
            if active is None or active.index_version != request.index_version:
                raise IndexVersionNotFoundError()
            records = {
                record.metadata.evidence_id: record
                for record in active.records
                if record.metadata.evidence_id not in set(request.evidence_ids)
            }
            proposed = self._snapshot(request.index_name, request.tenant_scope, request.index_version, records.values())
            self._assert_manifest(request.manifest, proposed.manifest)
            if active == proposed:
                return active.manifest
            await self._retriever.build(proposed)
            self._promote(key, proposed)
            return proposed.manifest

    async def retrieve(self, query: EvidenceQuery) -> RetrievalResult:
        self._validate_query(query)
        index_name: IndexName = "profile_evidence" if query.scope == "profile" else "job_requirements"
        snapshot = self._resolve_snapshot(index_name, query)
        eligible = self._eligible_records(snapshot.records, query)
        if not eligible and self._has_explicit_scope(query):
            raise RetrievalScopeMismatchError()

        allowed = {record.metadata.evidence_id: record for record in eligible}
        raw_hits = await self._retriever.retrieve(snapshot, query.query, query.top_k)
        evidence = self._validated_evidence(raw_hits, allowed, query.top_k)
        return RetrievalResult(retrieval_version=snapshot.index_version, evidence=tuple(evidence))

    def health(self) -> IndexHealth:
        return IndexHealth(
            ready=bool(self._retriever.ready),
            active_indexes=len(self._active),
            retired_indexes=sum(len(items) for items in self._retired.values()),
        )

    def _resolve_snapshot(
        self,
        index_name: IndexName,
        query: EvidenceQuery,
    ) -> IndexSnapshot:
        key = (index_name, query.tenant_scope)
        active = self._active.get(key)
        if active is None:
            raise IndexVersionNotFoundError()
        if query.index_version is not None:
            if active.index_version == query.index_version:
                return active
            for retired in reversed(self._retired.get(key, [])):
                if retired.index_version == query.index_version:
                    return retired
            raise IndexVersionNotFoundError()

        if not self._has_explicit_scope(query):
            return active

        if self._eligible_records(active.records, query):
            return active
        for retired in reversed(self._retired.get(key, [])):
            if self._eligible_records(retired.records, query):
                return retired
        return active

    def _promote(self, key: tuple[IndexName, str], snapshot: IndexSnapshot) -> None:
        previous = self._active.get(key)
        if previous is not None and previous.index_version != snapshot.index_version:
            retired = [item for item in self._retired[key] if item.index_version != previous.index_version]
            retired.append(previous)
            self._retired[key] = retired[-self._retained_versions :]
        elif previous is not None:
            self._retired[key] = [item for item in self._retired[key] if item.index_version != snapshot.index_version]
        self._active[key] = snapshot

    def _snapshot(
        self,
        index_name: IndexName,
        tenant_scope: str,
        index_version: str,
        records: object,
    ) -> IndexSnapshot:
        ordered = tuple(sorted(records, key=lambda item: item.metadata.evidence_id))
        return IndexSnapshot(
            index_name=index_name,
            tenant_scope=tenant_scope,
            index_version=index_version,
            manifest=self._manifest(ordered),
            records=ordered,
        )

    def _manifest(self, records: tuple[EvidenceRecord, ...]) -> IndexManifest:
        payload = [
            {
                "evidenceId": record.metadata.evidence_id,
                "contentHash": record.metadata.content_hash,
                "indexVersion": record.metadata.index_version,
            }
            for record in records
        ]
        encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        return IndexManifest(record_count=len(records), content_hash=hashlib.sha256(encoded).hexdigest())

    def _validate_upsert(self, request: UpsertRequest) -> None:
        self._validate_index_identity(request.index_name, request.tenant_scope, request.index_version)
        seen: set[str] = set()
        for record in request.records:
            self._validate_record(record, request.index_name, request.tenant_scope, request.index_version)
            if record.metadata.evidence_id in seen:
                raise ValueError("index_record_invalid")
            seen.add(record.metadata.evidence_id)

    def _validate_delete(self, request: DeleteRequest) -> None:
        self._validate_index_identity(request.index_name, request.tenant_scope, request.index_version)
        if not request.evidence_ids or len(request.evidence_ids) > 200:
            raise ValueError("index_delete_invalid")
        if any(not self._identifier(evidence_id) for evidence_id in request.evidence_ids):
            raise ValueError("index_delete_invalid")

    def _validate_query(self, query: EvidenceQuery) -> None:
        if (
            not isinstance(query.query, str)
            or not query.query.strip()
            or len(query.query) > MAX_QUERY_LENGTH
            or not self._identifier(query.tenant_scope)
            or query.scope not in ("profile", "job")
            or not isinstance(query.top_k, int)
            or isinstance(query.top_k, bool)
            or query.top_k < 1
            or query.top_k > MAX_RESULT_COUNT
        ):
            raise ValueError("retrieval_request_invalid")
        if query.profile_revision is not None and (not isinstance(query.profile_revision, int) or query.profile_revision < 1):
            raise ValueError("retrieval_request_invalid")
        if query.posting_id is not None and not self._identifier(query.posting_id):
            raise ValueError("retrieval_request_invalid")
        if query.index_version is not None and not self._identifier(query.index_version):
            raise ValueError("retrieval_request_invalid")

    def _validate_index_identity(self, index_name: str, tenant_scope: str, index_version: str) -> None:
        if index_name not in ("profile_evidence", "job_requirements"):
            raise ValueError("index_identity_invalid")
        if not self._identifier(tenant_scope) or not self._identifier(index_version):
            raise ValueError("index_identity_invalid")

    def _validate_record(
        self,
        record: EvidenceRecord,
        index_name: IndexName,
        tenant_scope: str,
        index_version: str,
    ) -> None:
        metadata = record.metadata
        if (
            not isinstance(record.text, str)
            or not record.text
            or len(record.text) > MAX_RECORD_TEXT_LENGTH
            or record.text != _SPACE.sub(" ", record.text).strip()
            or _HTML.search(record.text) is not None
            or _CREDENTIAL.search(record.text) is not None
            or metadata.tenant_scope != tenant_scope
            or metadata.index_version != index_version
            or not self._identifier(metadata.document_id)
            or not self._identifier(metadata.evidence_id)
            or not _HASH.fullmatch(metadata.content_hash)
            or hashlib.sha256(record.text.encode("utf-8")).hexdigest() != metadata.content_hash
            or metadata.page is not None and (not isinstance(metadata.page, int) or metadata.page < 1)
            or metadata.block_id is not None and not self._identifier(metadata.block_id)
        ):
            raise ValueError("index_record_invalid")
        if index_name == "profile_evidence":
            if metadata.profile_revision is None or metadata.profile_revision < 1 or metadata.posting_id is not None:
                raise ValueError("index_record_invalid")
        elif metadata.posting_id is None or not self._identifier(metadata.posting_id) or metadata.profile_revision is not None:
            raise ValueError("index_record_invalid")

    def _eligible_records(self, records: tuple[EvidenceRecord, ...], query: EvidenceQuery) -> tuple[EvidenceRecord, ...]:
        return tuple(record for record in records if (
            (query.profile_revision is None or record.metadata.profile_revision == query.profile_revision)
            and (query.posting_id is None or record.metadata.posting_id == query.posting_id)
        ))

    def _has_explicit_scope(self, query: EvidenceQuery) -> bool:
        return query.profile_revision is not None or query.posting_id is not None

    def _validated_evidence(
        self,
        hits: object,
        allowed: dict[str, EvidenceRecord],
        top_k: int,
    ) -> list[EvidenceReference]:
        if not isinstance(hits, (list, tuple)):
            raise ValueError("retrieval_result_invalid")
        results: list[EvidenceReference] = []
        seen: set[str] = set()
        for hit in hits:
            if not isinstance(hit, RetrievalHit) or not math.isfinite(hit.score) or hit.score < 0 or hit.score > 1:
                raise ValueError("retrieval_result_invalid")
            if hit.evidence_id in seen:
                continue
            record = allowed.get(hit.evidence_id)
            if record is None:
                continue
            seen.add(hit.evidence_id)
            results.append(EvidenceReference(
                evidence_id=record.metadata.evidence_id,
                document_id=record.metadata.document_id,
                page=record.metadata.page,
                block_id=record.metadata.block_id,
                quote_hash=record.metadata.content_hash,
                score=hit.score,
            ))
            if len(results) == top_k:
                break
        return results

    @staticmethod
    def _assert_manifest(expected: IndexManifest, actual: IndexManifest) -> None:
        if expected != actual:
            raise ValueError("index_manifest_mismatch")

    @staticmethod
    def _identifier(value: object) -> bool:
        return isinstance(value, str) and 0 < len(value) <= 200 and value == value.strip() and "\x00" not in value
