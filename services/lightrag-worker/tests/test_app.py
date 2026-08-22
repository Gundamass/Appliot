import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from lightrag_worker.app import WorkerSettings, create_app, create_production_app
from lightrag_worker.index_manager import IndexManager
from lightrag_worker.types import RetrievalHit


TOKEN = "worker-test-token"


class FakeContextRetriever:
    ready = True

    async def build(self, _snapshot):
        return None

    async def retrieve(self, snapshot, _query: str, top_k: int):
        return [
            RetrievalHit(evidence_id=record.metadata.evidence_id, score=0.9)
            for record in snapshot.records[:top_k]
        ]


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def request_payload():
    text = "Kubernetes experience"
    record = {
        "text": text,
        "metadata": {
            "tenantScope": "tenant-a",
            "documentId": "resume-a",
            "postingId": None,
            "profileRevision": 3,
            "page": 2,
            "blockId": "skills",
            "evidenceId": "evidence-a",
            "contentHash": content_hash(text),
            "indexVersion": "profile-r3",
        },
    }
    manifest_payload = [{
        "evidenceId": "evidence-a",
        "contentHash": content_hash(text),
        "indexVersion": "profile-r3",
    }]
    return {
        "indexName": "profile_evidence",
        "tenantScope": "tenant-a",
        "indexVersion": "profile-r3",
        "manifest": {
            "recordCount": 1,
            "contentHash": hashlib.sha256(
                json.dumps(manifest_payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
            ).hexdigest(),
        },
        "records": [record],
    }


def test_authenticated_context_only_api_validates_scope_and_request_limits():
    manager = IndexManager(FakeContextRetriever())
    client = TestClient(create_app(manager, WorkerSettings(api_token=TOKEN)))
    headers = {"Authorization": f"Bearer {TOKEN}"}

    assert client.post("/v1/indexes/upsert", json=request_payload()).status_code == 401

    indexed = client.post("/v1/indexes/upsert", headers=headers, json=request_payload())
    assert indexed.status_code == 200
    assert indexed.json()["manifest"]["recordCount"] == 1

    retrieved = client.post("/v1/retrieve", headers=headers, json={
        "query": "container platform",
        "scope": "profile",
        "tenantScope": "tenant-a",
        "profileRevision": 3,
        "topK": 3,
    })
    assert retrieved.status_code == 200
    assert retrieved.json() == {
        "provider": "lightrag",
        "retrievalVersion": "profile-r3",
        "scope": {
            "kind": "profile",
            "tenantScope": "tenant-a",
            "profileRevision": 3,
        },
        "evidence": [{
            "evidenceId": "evidence-a",
            "documentId": "resume-a",
            "page": 2,
            "blockId": "skills",
            "quoteHash": content_hash("Kubernetes experience"),
            "score": 0.9,
        }],
    }
    assert "answer" not in retrieved.json()

    scope_mismatch = client.post("/v1/retrieve", headers=headers, json={
        "query": "container platform",
        "scope": "profile",
        "tenantScope": "tenant-a",
        "profileRevision": 2,
        "topK": 3,
    })
    assert scope_mismatch.status_code == 409
    assert scope_mismatch.json() == {"code": "retrieval_scope_mismatch"}

    too_many = client.post("/v1/retrieve", headers=headers, json={
        "query": "container platform",
        "scope": "profile",
        "tenantScope": "tenant-a",
        "profileRevision": 3,
        "topK": 21,
    })
    assert too_many.status_code == 422


def test_health_delete_and_stale_versions_are_bounded_to_the_active_index():
    manager = IndexManager(FakeContextRetriever())
    client = TestClient(create_app(manager, WorkerSettings(api_token=TOKEN)))
    headers = {"Authorization": f"Bearer {TOKEN}"}

    assert client.get("/v1/health", headers=headers).json() == {
        "ready": True,
        "active_indexes": 0,
        "retired_indexes": 0,
    }
    assert client.post("/v1/indexes/upsert", headers=headers, json=request_payload()).status_code == 200

    stale = client.post("/v1/retrieve", headers=headers, json={
        "query": "container platform",
        "scope": "profile",
        "tenantScope": "tenant-a",
        "profileRevision": 3,
        "indexVersion": "profile-r2",
        "topK": 3,
    })
    assert stale.status_code == 404
    assert stale.json() == {"code": "retrieval_index_missing"}

    empty_manifest = {"recordCount": 0, "contentHash": hashlib.sha256(b"[]").hexdigest()}
    deleted = client.post("/v1/indexes/delete", headers=headers, json={
        "indexName": "profile_evidence",
        "tenantScope": "tenant-a",
        "indexVersion": "profile-r3",
        "evidenceIds": ["evidence-a"],
        "manifest": empty_manifest,
    })
    assert deleted.status_code == 200
    assert deleted.json() == {"manifest": empty_manifest}


def test_production_app_requires_explicit_model_configuration_or_an_injected_runtime(tmp_path):
    settings = WorkerSettings(api_token=TOKEN, data_directory=tmp_path)

    with pytest.raises(ValueError, match="worker_model_config_required"):
        create_production_app(settings)

    client = TestClient(create_production_app(
        settings,
        runtime_factory=lambda _snapshot: FakeContextRetriever(),
    ))

    assert client.get("/v1/health", headers={"Authorization": f"Bearer {TOKEN}"}).json() == {
        "ready": True,
        "active_indexes": 0,
        "retired_indexes": 0,
    }
