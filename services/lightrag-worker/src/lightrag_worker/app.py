from __future__ import annotations

import hmac
from dataclasses import asdict
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .config import WorkerSettings
from .index_manager import IndexManager, IndexVersionNotFoundError, RetrievalScopeMismatchError
from .model_bindings import create_openai_compatible_model_bindings
from .retriever import LightRAGHybridRetriever, RuntimeFactory, create_lightrag_runtime_factory
from .types import DeleteRequest, EvidenceMetadata, EvidenceQuery, EvidenceRecord, IndexManifest, UpsertRequest


MAX_TOP_K = 20


class ManifestBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    record_count: int = Field(alias="recordCount", ge=0)
    content_hash: str = Field(alias="contentHash", min_length=64, max_length=64)


class MetadataBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tenant_scope: str = Field(alias="tenantScope", min_length=1, max_length=200)
    document_id: str = Field(alias="documentId", min_length=1, max_length=200)
    posting_id: str | None = Field(alias="postingId", default=None, max_length=200)
    profile_revision: int | None = Field(alias="profileRevision", default=None, ge=1)
    page: int | None = Field(default=None, ge=1)
    block_id: str | None = Field(alias="blockId", default=None, max_length=200)
    evidence_id: str = Field(alias="evidenceId", min_length=1, max_length=200)
    content_hash: str = Field(alias="contentHash", min_length=64, max_length=64)
    index_version: str = Field(alias="indexVersion", min_length=1, max_length=200)


class EvidenceRecordBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=6_000)
    metadata: MetadataBody


class UpsertBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index_name: Literal["profile_evidence", "job_requirements"] = Field(alias="indexName")
    tenant_scope: str = Field(alias="tenantScope", min_length=1, max_length=200)
    index_version: str = Field(alias="indexVersion", min_length=1, max_length=200)
    manifest: ManifestBody
    records: list[EvidenceRecordBody] = Field(max_length=200)


class DeleteBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    index_name: Literal["profile_evidence", "job_requirements"] = Field(alias="indexName")
    tenant_scope: str = Field(alias="tenantScope", min_length=1, max_length=200)
    index_version: str = Field(alias="indexVersion", min_length=1, max_length=200)
    evidence_ids: list[str] = Field(alias="evidenceIds", min_length=1, max_length=200)
    manifest: ManifestBody


class RetrieveBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    query: str = Field(min_length=1, max_length=2_000)
    scope: Literal["profile", "job"]
    tenant_scope: str = Field(alias="tenantScope", min_length=1, max_length=200)
    profile_revision: int | None = Field(alias="profileRevision", default=None, ge=1)
    posting_id: str | None = Field(alias="postingId", default=None, max_length=200)
    top_k: int = Field(alias="topK", ge=1, le=MAX_TOP_K)
    index_version: str | None = Field(alias="indexVersion", default=None, max_length=200)


def create_app(manager: IndexManager, settings: WorkerSettings) -> FastAPI:
    if not settings.api_token:
        raise ValueError("worker_api_token_required")
    app = FastAPI()

    def require_auth(authorization: Annotated[str | None, Header()] = None) -> None:
        if authorization is None or not authorization.startswith("Bearer "):
            raise _unauthorized()
        token = authorization.removeprefix("Bearer ")
        if not token or not hmac.compare_digest(token, settings.api_token):
            raise _unauthorized()

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content={"code": "retrieval_request_invalid"})

    @app.exception_handler(RetrievalScopeMismatchError)
    async def scope_mismatch(_: Request, __: RetrievalScopeMismatchError) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"code": "retrieval_scope_mismatch"})

    @app.exception_handler(IndexVersionNotFoundError)
    async def index_missing(_: Request, __: IndexVersionNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_404_NOT_FOUND, content={"code": "retrieval_index_missing"})

    @app.exception_handler(ValueError)
    async def invalid_index(_: Request, error: ValueError) -> JSONResponse:
        return JSONResponse(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, content={"code": str(error)})

    @app.get("/v1/health", dependencies=[Depends(require_auth)])
    async def health() -> dict[str, object]:
        return asdict(manager.health())

    @app.post("/v1/indexes/upsert", dependencies=[Depends(require_auth)])
    async def upsert(body: UpsertBody) -> dict[str, object]:
        request = UpsertRequest(
            index_name=body.index_name,
            tenant_scope=body.tenant_scope,
            index_version=body.index_version,
            manifest=IndexManifest(body.manifest.record_count, body.manifest.content_hash),
            records=tuple(_record(item) for item in body.records),
        )
        result = await manager.upsert(request)
        return {"manifest": _manifest(result)}

    @app.post("/v1/indexes/delete", dependencies=[Depends(require_auth)])
    async def delete(body: DeleteBody) -> dict[str, object]:
        result = await manager.delete(DeleteRequest(
            index_name=body.index_name,
            tenant_scope=body.tenant_scope,
            index_version=body.index_version,
            evidence_ids=tuple(body.evidence_ids),
            manifest=IndexManifest(body.manifest.record_count, body.manifest.content_hash),
        ))
        return {"manifest": _manifest(result)}

    @app.post("/v1/retrieve", dependencies=[Depends(require_auth)])
    async def retrieve(body: RetrieveBody) -> dict[str, object]:
        result = await manager.retrieve(EvidenceQuery(
            query=body.query,
            scope=body.scope,
            tenant_scope=body.tenant_scope,
            profile_revision=body.profile_revision,
            posting_id=body.posting_id,
            top_k=body.top_k,
            index_version=body.index_version,
        ))
        scope: dict[str, object] = {"kind": body.scope, "tenantScope": body.tenant_scope}
        if body.profile_revision is not None:
            scope["profileRevision"] = body.profile_revision
        if body.posting_id is not None:
            scope["postingId"] = body.posting_id
        return {
            "provider": "lightrag",
            "retrievalVersion": result.retrieval_version,
            "scope": scope,
            "evidence": [
                {
                    "evidenceId": item.evidence_id,
                    "documentId": item.document_id,
                    **({"page": item.page} if item.page is not None else {}),
                    **({"blockId": item.block_id} if item.block_id is not None else {}),
                    "quoteHash": item.quote_hash,
                    "score": item.score,
                }
                for item in result.evidence
            ],
        }

    return app


def create_production_app(
    settings: WorkerSettings,
    *,
    runtime_factory: RuntimeFactory | None = None,
) -> FastAPI:
    if runtime_factory is None:
        if settings.model is None:
            raise ValueError("worker_model_config_required")
        factory = create_lightrag_runtime_factory(
            settings.data_directory,
            bindings=create_openai_compatible_model_bindings(settings.model),
        )
    else:
        factory = runtime_factory
    return create_app(IndexManager(LightRAGHybridRetriever(factory)), settings)


def _record(body: EvidenceRecordBody) -> EvidenceRecord:
    metadata = body.metadata
    return EvidenceRecord(
        text=body.text,
        metadata=EvidenceMetadata(
            tenant_scope=metadata.tenant_scope,
            document_id=metadata.document_id,
            posting_id=metadata.posting_id,
            profile_revision=metadata.profile_revision,
            page=metadata.page,
            block_id=metadata.block_id,
            evidence_id=metadata.evidence_id,
            content_hash=metadata.content_hash,
            index_version=metadata.index_version,
        ),
    )


def _manifest(manifest: IndexManifest) -> dict[str, object]:
    return {"recordCount": manifest.record_count, "contentHash": manifest.content_hash}


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized.",
        headers={"WWW-Authenticate": "Bearer"},
    )
