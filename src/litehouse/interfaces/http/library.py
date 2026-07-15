from __future__ import annotations

import hmac
import json
from typing import Annotated, Literal, Self, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import (
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    StringConstraints,
    field_validator,
    model_validator,
)

from litehouse.config import Settings
from litehouse.domain import canonical_json
from litehouse.infrastructure.documents.models import AccessAssertion, DocumentProvider
from litehouse.infrastructure.vault.models import (
    Annotation,
    AnnotationKind,
    ArtifactKind,
    BlobVerification,
    BlobVerificationStatus,
    LibraryItem,
    LibraryItemKind,
    ManifestVerification,
    ManifestVerificationStatus,
    ReadingProgress,
    VaultArtifact,
)
from litehouse.infrastructure.vault.paths import VaultPathError
from litehouse.infrastructure.vault.repository import (
    ArtifactNotFoundError,
    IdempotencyConflictError,
    LibraryItemNotFoundError,
)
from litehouse.infrastructure.vault.store import VaultIntegrityError
from litehouse.interfaces.http.library_service import (
    LibraryAcquisitionError,
    LibraryArtifactNotExportableError,
    LibraryArtifactNotPdfError,
    LibraryExportTooLargeError,
    LibraryHttpService,
    LibraryPdfTooLargeError,
)

OpaqueId = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
    ),
]
ShortMediaType = Annotated[
    str,
    StringConstraints(strip_whitespace=True, to_lower=True, min_length=1, max_length=160),
]
_MAX_JSON_DOCUMENT_BYTES = 64 * 1024


class LibraryContract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class ArtifactSourceResponse(LibraryContract):
    name: str | None
    url: str | None
    license_expression: str | None
    license_url: str | None
    receipt_sha256: str | None
    provenance_sha256: str


class LibraryItemResponse(LibraryContract):
    id: OpaqueId
    title: str
    kind: LibraryItemKind
    identity_sha256: str
    added_at: AwareDatetime
    work_id: str | None

    @classmethod
    def from_domain(cls, item: LibraryItem) -> Self:
        return cls(
            id=item.id,
            title=item.title,
            kind=item.kind,
            identity_sha256=item.identity_sha256,
            added_at=item.added_at,
            work_id=item.work_id,
        )


class ArtifactResponse(LibraryContract):
    id: OpaqueId
    library_item_id: OpaqueId
    kind: ArtifactKind
    media_type: ShortMediaType
    sha256: str
    size: int = Field(ge=0)
    source: ArtifactSourceResponse
    created_at: AwareDatetime

    @classmethod
    def from_domain(cls, artifact: VaultArtifact) -> Self:
        return cls(
            id=artifact.id,
            library_item_id=artifact.library_item_id,
            kind=artifact.kind,
            media_type=artifact.media_type,
            sha256=artifact.blob.sha256,
            size=artifact.blob.size,
            source=ArtifactSourceResponse(
                name=artifact.source.name,
                url=artifact.source.url,
                license_expression=artifact.source.license_expression,
                license_url=artifact.source.license_url,
                receipt_sha256=artifact.source.receipt_sha256,
                provenance_sha256=artifact.source.provenance_sha256,
            ),
            created_at=artifact.created_at,
        )


class ReaderArtifactResponse(LibraryContract):
    item: LibraryItemResponse
    artifact: ArtifactResponse


class OpenAccessAcquisitionRequest(LibraryContract):
    provider: DocumentProvider
    repository_id: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=128),
    ]
    title: str = Field(min_length=1, max_length=1_000)
    exact_pdf_path: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=256),
    ] | None = None

    @model_validator(mode="after")
    def provider_contract(self) -> Self:
        if "://" in self.repository_id or (
            self.exact_pdf_path is not None and "://" in self.exact_pdf_path
        ):
            raise ValueError("Document URLs are not accepted.")
        if self.provider is DocumentProvider.ARXIV and self.exact_pdf_path is not None:
            raise ValueError("arXiv PDF paths are derived from the identifier.")
        if self.provider is DocumentProvider.PMC and self.exact_pdf_path is None:
            raise ValueError("A canonical PMC open-access PDF path is required.")
        return self


class OpenAccessAcquisitionResponse(LibraryContract):
    item: LibraryItemResponse
    pdf_artifact: ArtifactResponse
    receipt_artifact: ArtifactResponse
    access_assertion: AccessAssertion
    access_evidence_url: str
    reuse_license_expression: None = None
    reuse_license_verified: bool = False


class ArtifactVerificationResponse(LibraryContract):
    status: BlobVerificationStatus
    expected_sha256: str
    actual_sha256: str | None

    @classmethod
    def from_domain(cls, verification: BlobVerification) -> Self:
        return cls(
            status=verification.status,
            expected_sha256=verification.expected_sha256,
            actual_sha256=verification.actual_sha256,
        )


class ManifestVerificationRequest(LibraryContract):
    material_artifact_ids: tuple[OpaqueId, ...] = Field(default=(), max_length=128)

    @field_validator("material_artifact_ids")
    @classmethod
    def unique_material(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(set(values)) != len(values):
            raise ValueError("Material artifact IDs must be unique.")
        return values


class ManifestVerificationResponse(LibraryContract):
    status: ManifestVerificationStatus
    reasons: tuple[str, ...]
    report_artifact_sha256: str | None
    manifest_sha256: str | None
    scientific_validity_assessed: bool
    scope_statement: str

    @classmethod
    def from_domain(cls, verification: ManifestVerification) -> Self:
        return cls(
            status=verification.status,
            reasons=verification.reasons,
            report_artifact_sha256=verification.report_artifact_sha256,
            manifest_sha256=verification.manifest_sha256,
            scientific_validity_assessed=verification.scientific_validity_assessed,
            scope_statement=verification.scope_statement,
        )


class ReadingProgressRequest(LibraryContract):
    position_fraction: float = Field(ge=0, le=1, allow_inf_nan=False)
    locator: dict[str, JsonValue] = Field(default_factory=dict)
    page_number: int | None = Field(default=None, ge=1)
    page_count: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def valid_document(self) -> Self:
        if self.page_number is not None and self.page_count is not None:
            if self.page_number > self.page_count:
                raise ValueError("Page number cannot exceed page count.")
        _bounded_json(self.locator, name="Reading locator")
        return self


class ReadingProgressResponse(LibraryContract):
    artifact_id: OpaqueId
    position_fraction: float
    locator: dict[str, JsonValue]
    updated_at: AwareDatetime
    page_number: int | None
    page_count: int | None

    @classmethod
    def from_domain(cls, progress: ReadingProgress) -> Self:
        return cls(
            artifact_id=progress.artifact_id,
            position_fraction=progress.position_fraction,
            locator=_stored_json_object(progress.locator_json),
            updated_at=progress.updated_at,
            page_number=progress.page_number,
            page_count=progress.page_count,
        )


class AddAnnotationRequest(LibraryContract):
    kind: AnnotationKind
    body: str = Field(default="", max_length=65_536)
    anchor: dict[str, JsonValue] = Field(default_factory=dict)
    artifact_id: OpaqueId | None = None
    quote_text: str | None = Field(default=None, max_length=65_536)
    page_number: int | None = Field(default=None, ge=1)
    idempotency_key: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=1, max_length=128),
    ] | None = None

    @model_validator(mode="after")
    def valid_annotation(self) -> Self:
        if not self.body.strip() and not (self.quote_text and self.quote_text.strip()):
            raise ValueError("An annotation requires text or a quotation.")
        _bounded_json(self.anchor, name="Annotation anchor")
        return self


class AnnotationResponse(LibraryContract):
    id: OpaqueId
    library_item_id: OpaqueId
    kind: AnnotationKind
    body: str
    anchor: dict[str, JsonValue]
    content_sha256: str
    idempotency_key: str
    created_at: AwareDatetime
    updated_at: AwareDatetime
    artifact_id: OpaqueId | None
    quote_text: str | None
    page_number: int | None

    @classmethod
    def from_domain(cls, annotation: Annotation) -> Self:
        return cls(
            id=annotation.id,
            library_item_id=annotation.library_item_id,
            kind=annotation.kind,
            body=annotation.body,
            anchor=_stored_json_object(annotation.anchor_json),
            content_sha256=annotation.content_sha256,
            idempotency_key=annotation.idempotency_key,
            created_at=annotation.created_at,
            updated_at=annotation.updated_at,
            artifact_id=annotation.artifact_id,
            quote_text=annotation.quote_text,
            page_number=annotation.page_number,
        )


def _bounded_json(value: dict[str, JsonValue], *, name: str) -> None:
    if len(canonical_json(value).encode("utf-8")) > _MAX_JSON_DOCUMENT_BYTES:
        raise ValueError(f"{name} exceeds the safe size limit.")


def _stored_json_object(value: str) -> dict[str, JsonValue]:
    document = json.loads(value)
    if not isinstance(document, dict):
        raise VaultIntegrityError("Stored reader data is not a JSON object.")
    return cast(dict[str, JsonValue], document)


def _authorized_service(request: Request) -> LibraryHttpService:
    settings = getattr(request.app.state, "settings", None)
    if not isinstance(settings, Settings):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The local library service is unavailable.",
        )
    authorizations = request.headers.getlist("authorization")
    authorization = authorizations[0] if len(authorizations) == 1 else ""
    scheme, separator, supplied = authorization.partition(" ")
    expected = settings.session_token.get_secret_value()
    valid = (
        len(authorizations) == 1
        and separator == " "
        and scheme.casefold() == "bearer"
        and " " not in supplied
        and hmac.compare_digest(supplied.encode(), expected.encode())
    )
    if not valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    service = getattr(request.app.state, "library_service", None)
    if not isinstance(service, LibraryHttpService):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The local library service is unavailable.",
        )
    return service


LibraryServiceDependency = Annotated[LibraryHttpService, Depends(_authorized_service)]


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found.")


def _integrity_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail="The stored library data failed integrity validation.",
    )


def _validation_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail="The library request could not be processed.",
    )


def create_library_router() -> APIRouter:
    router = APIRouter(prefix="/v1/library", tags=["library"])

    @router.get("/items", response_model=list[LibraryItemResponse])
    async def list_items(
        service: LibraryServiceDependency,
        offset: int = Query(default=0, ge=0, le=1_000_000),
        limit: int = Query(default=100, ge=1, le=200),
    ) -> list[LibraryItemResponse]:
        items = await service.list_items(offset=offset, limit=limit)
        return [LibraryItemResponse.from_domain(item) for item in items]

    @router.get(
        "/items/{library_item_id}/artifacts",
        response_model=list[ArtifactResponse],
    )
    async def list_artifacts(
        library_item_id: OpaqueId,
        service: LibraryServiceDependency,
        offset: int = Query(default=0, ge=0, le=1_000_000),
        limit: int = Query(default=100, ge=1, le=200),
    ) -> list[ArtifactResponse]:
        try:
            artifacts = await service.list_artifacts(
                library_item_id,
                offset=offset,
                limit=limit,
            )
        except LibraryItemNotFoundError:
            raise _not_found() from None
        return [ArtifactResponse.from_domain(artifact) for artifact in artifacts]

    @router.get(
        "/items/{library_item_id}/reader",
        response_model=ReaderArtifactResponse,
    )
    async def reader_artifact(
        library_item_id: OpaqueId,
        service: LibraryServiceDependency,
    ) -> ReaderArtifactResponse:
        try:
            selected = await service.get_reader_artifact(library_item_id)
        except (LibraryItemNotFoundError, LibraryArtifactNotPdfError):
            raise _not_found() from None
        return ReaderArtifactResponse(
            item=LibraryItemResponse.from_domain(selected.item),
            artifact=ArtifactResponse.from_domain(selected.artifact),
        )

    @router.get("/artifacts/{artifact_id}/content")
    async def artifact_content(
        artifact_id: OpaqueId,
        request: Request,
        service: LibraryServiceDependency,
    ) -> Response:
        if request.url.query:
            raise _validation_error()
        try:
            selected = await service.read_reader_pdf(artifact_id)
        except ArtifactNotFoundError:
            raise _not_found() from None
        except LibraryPdfTooLargeError:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="The PDF exceeds the 100 MiB reader limit.",
            ) from None
        except LibraryArtifactNotPdfError:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail="The artifact is not a supported PDF.",
            ) from None
        except (VaultIntegrityError, VaultPathError, FileNotFoundError):
            raise _integrity_error() from None
        artifact = selected.artifact
        return Response(
            content=selected.content,
            media_type="application/pdf",
            headers={
                "Cache-Control": "no-store",
                "Pragma": "no-cache",
                "Content-Length": str(artifact.blob.size),
                "Content-Disposition": 'inline; filename="litehouse-artifact.pdf"',
                "ETag": f'"{artifact.blob.sha256}"',
                "X-Content-Type-Options": "nosniff",
                "X-Litehouse-Artifact-ID": artifact.id,
                "X-Litehouse-Content-SHA256": artifact.blob.sha256,
            },
        )

    @router.get("/artifacts/{artifact_id}/export")
    async def export_artifact(
        artifact_id: OpaqueId,
        request: Request,
        service: LibraryServiceDependency,
    ) -> Response:
        if request.url.query:
            raise _validation_error()
        try:
            selected = await service.read_exportable_artifact(artifact_id)
        except ArtifactNotFoundError:
            raise _not_found() from None
        except LibraryExportTooLargeError:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="The artifact exceeds the 100 MiB export limit.",
            ) from None
        except LibraryArtifactNotExportableError:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail="The artifact is not a supported report or reference export.",
            ) from None
        except (VaultIntegrityError, VaultPathError, FileNotFoundError):
            raise _integrity_error() from None
        artifact = selected.artifact
        return Response(
            content=selected.content,
            media_type=artifact.media_type,
            headers={
                "Cache-Control": "no-store",
                "Pragma": "no-cache",
                "Content-Length": str(artifact.blob.size),
                "Content-Disposition": 'attachment; filename="litehouse-artifact"',
                "ETag": f'"{artifact.blob.sha256}"',
                "X-Content-Type-Options": "nosniff",
                "X-Litehouse-Artifact-ID": artifact.id,
                "X-Litehouse-Content-SHA256": artifact.blob.sha256,
            },
        )

    @router.post(
        "/open-access/acquisitions",
        response_model=OpenAccessAcquisitionResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def acquire_open_access_pdf(
        payload: OpenAccessAcquisitionRequest,
        service: LibraryServiceDependency,
    ) -> OpenAccessAcquisitionResponse:
        try:
            acquired = await service.acquire_open_access_pdf(
                provider=payload.provider,
                repository_id=payload.repository_id,
                exact_pdf_path=payload.exact_pdf_path,
                title=payload.title,
            )
        except LibraryAcquisitionError as error:
            if error.code == "response_too_large":
                status_code = status.HTTP_413_CONTENT_TOO_LARGE
            elif error.code == "document_request_rejected":
                status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
            elif error.retryable:
                status_code = status.HTTP_503_SERVICE_UNAVAILABLE
            else:
                status_code = status.HTTP_502_BAD_GATEWAY
            raise HTTPException(
                status_code=status_code,
                detail={
                    "code": error.code,
                    "message": error.safe_message,
                    "retryable": error.retryable,
                },
            ) from None
        return OpenAccessAcquisitionResponse(
            item=LibraryItemResponse.from_domain(acquired.item),
            pdf_artifact=ArtifactResponse.from_domain(acquired.pdf_artifact),
            receipt_artifact=ArtifactResponse.from_domain(acquired.receipt_artifact),
            access_assertion=acquired.access_assertion,
            access_evidence_url=acquired.pdf_artifact.source.license_url or "",
            reuse_license_verified=acquired.reuse_license_verified,
        )

    @router.post(
        "/artifacts/{artifact_id}/verify",
        response_model=ArtifactVerificationResponse,
    )
    async def verify_artifact(
        artifact_id: OpaqueId,
        service: LibraryServiceDependency,
    ) -> ArtifactVerificationResponse:
        try:
            verification = await service.verify_artifact(artifact_id)
        except ArtifactNotFoundError:
            raise _not_found() from None
        except (VaultIntegrityError, VaultPathError):
            raise _integrity_error() from None
        return ArtifactVerificationResponse.from_domain(verification)

    @router.post(
        "/artifacts/{artifact_id}/progress",
        response_model=ReadingProgressResponse,
    )
    async def save_progress(
        artifact_id: OpaqueId,
        payload: ReadingProgressRequest,
        service: LibraryServiceDependency,
    ) -> ReadingProgressResponse:
        try:
            progress = await service.save_progress(
                artifact_id=artifact_id,
                position_fraction=payload.position_fraction,
                locator=cast(dict[str, object], payload.locator),
                page_number=payload.page_number,
                page_count=payload.page_count,
            )
        except ArtifactNotFoundError:
            raise _not_found() from None
        except ValueError:
            raise _validation_error() from None
        return ReadingProgressResponse.from_domain(progress)

    @router.get(
        "/artifacts/{artifact_id}/progress",
        response_model=ReadingProgressResponse | None,
    )
    async def get_progress(
        artifact_id: OpaqueId,
        service: LibraryServiceDependency,
    ) -> ReadingProgressResponse | None:
        try:
            progress = await service.get_progress(artifact_id)
            return None if progress is None else ReadingProgressResponse.from_domain(progress)
        except ArtifactNotFoundError:
            raise _not_found() from None
        except (json.JSONDecodeError, VaultIntegrityError):
            raise _integrity_error() from None

    @router.post(
        "/items/{library_item_id}/annotations",
        response_model=AnnotationResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def add_annotation(
        library_item_id: OpaqueId,
        payload: AddAnnotationRequest,
        service: LibraryServiceDependency,
    ) -> AnnotationResponse:
        try:
            annotation = await service.add_annotation(
                library_item_id=library_item_id,
                kind=payload.kind,
                body=payload.body,
                anchor=cast(dict[str, object], payload.anchor),
                artifact_id=payload.artifact_id,
                quote_text=payload.quote_text,
                page_number=payload.page_number,
                idempotency_key=payload.idempotency_key,
            )
        except (LibraryItemNotFoundError, ArtifactNotFoundError):
            raise _not_found() from None
        except IdempotencyConflictError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The annotation idempotency key already describes different content.",
            ) from None
        except ValueError:
            raise _validation_error() from None
        return AnnotationResponse.from_domain(annotation)

    @router.get(
        "/items/{library_item_id}/annotations",
        response_model=list[AnnotationResponse],
    )
    async def list_annotations(
        library_item_id: OpaqueId,
        service: LibraryServiceDependency,
        offset: int = Query(default=0, ge=0, le=1_000_000),
        limit: int = Query(default=200, ge=1, le=500),
    ) -> list[AnnotationResponse]:
        try:
            annotations = await service.list_annotations(
                library_item_id,
                offset=offset,
                limit=limit,
            )
        except LibraryItemNotFoundError:
            raise _not_found() from None
        try:
            return [AnnotationResponse.from_domain(annotation) for annotation in annotations]
        except (json.JSONDecodeError, VaultIntegrityError):
            raise _integrity_error() from None

    @router.post(
        "/manifests/{manifest_id}/verify",
        response_model=ManifestVerificationResponse,
    )
    async def verify_manifest(
        manifest_id: OpaqueId,
        payload: ManifestVerificationRequest,
        service: LibraryServiceDependency,
    ) -> ManifestVerificationResponse:
        try:
            verification = await service.verify_manifest(
                manifest_id,
                payload.material_artifact_ids,
            )
        except ArtifactNotFoundError:
            raise _not_found() from None
        except (VaultIntegrityError, VaultPathError):
            raise _integrity_error() from None
        return ManifestVerificationResponse.from_domain(verification)

    @router.get("/items/{library_item_id}/notes/export")
    async def export_notes(
        library_item_id: OpaqueId,
        service: LibraryServiceDependency,
        export_format: Literal["markdown", "json"] = Query(
            default="markdown",
            alias="format",
        ),
    ) -> Response:
        try:
            exported = await service.export_notes(library_item_id, export_format)
        except LibraryItemNotFoundError:
            raise _not_found() from None
        except LibraryExportTooLargeError:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="The note export is too large for an HTTP response.",
            ) from None
        return Response(
            content=exported.content,
            media_type=exported.media_type,
            headers={
                "Cache-Control": "no-store",
                "X-Litehouse-Content-SHA256": exported.sha256,
            },
        )

    return router
