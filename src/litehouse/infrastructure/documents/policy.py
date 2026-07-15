from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit

from litehouse.infrastructure.documents.models import (
    AccessAssertion,
    DocumentProvider,
    DocumentRequest,
    OpenAccessEvidence,
)

_ARXIV_ID = re.compile(
    r"^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v[1-9]\d*)?$"
)
_ARXIV_PATH = re.compile(
    r"^/pdf/(?P<identifier>(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})"
    r"(?:v[1-9]\d*)?)$"
)
_PMC_ID = re.compile(r"^PMC[1-9]\d*$")
_PMC_PATH = re.compile(
    r"^/pub/pmc/oa_pdf/[a-z0-9]{2}/[a-z0-9]{2}/"
    r"[A-Za-z0-9][A-Za-z0-9._-]{0,160}\.(?P<identifier>PMC[1-9]\d*)\.pdf$"
)
_LICENSE_URLS = {
    AccessAssertion.OPEN_ACCESS: frozenset(
        {
            "https://pmc.ncbi.nlm.nih.gov/tools/openftlist/",
            "https://info.arxiv.org/help/license/index.html",
        }
    ),
    AccessAssertion.PUBLIC_DOMAIN: frozenset(
        {"https://creativecommons.org/publicdomain/mark/1.0/"}
    ),
    AccessAssertion.CC0: frozenset(
        {"https://creativecommons.org/publicdomain/zero/1.0/"}
    ),
    AccessAssertion.CC_BY: frozenset({"https://creativecommons.org/licenses/by/4.0/"}),
    AccessAssertion.CC_BY_SA: frozenset(
        {"https://creativecommons.org/licenses/by-sa/4.0/"}
    ),
}
_PROVIDER_OPEN_ACCESS_URL = {
    DocumentProvider.ARXIV: "https://info.arxiv.org/help/license/index.html",
    DocumentProvider.PMC: "https://pmc.ncbi.nlm.nih.gov/tools/openftlist/",
}


class DocumentPolicyError(ValueError):
    """Raised when a document request is outside a fixed provider contract."""


@dataclass(frozen=True, slots=True)
class ApprovedDocumentTarget:
    provider: DocumentProvider
    host: str
    path: str

    @property
    def url(self) -> str:
        return f"https://{self.host}{self.path}"


class DocumentPolicy:
    def build_target(self, request: DocumentRequest) -> ApprovedDocumentTarget:
        self._validate_common(request)
        if request.provider is DocumentProvider.ARXIV:
            return self._arxiv_target(request.repository_id, request.exact_pdf_path)
        if request.provider is DocumentProvider.PMC:
            return self._pmc_target(request.repository_id, request.exact_pdf_path)
        raise DocumentPolicyError("Document provider is not enabled.")

    def validate_constructed_url(self, target: ApprovedDocumentTarget) -> SplitResult:
        url = target.url
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != target.host
            or parsed.port not in (None, 443)
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path != target.path
        ):
            raise DocumentPolicyError("Constructed document destination is not canonical.")
        return parsed

    @staticmethod
    def validate_evidence(evidence: OpenAccessEvidence, request: DocumentRequest) -> None:
        if not isinstance(evidence, OpenAccessEvidence):
            raise DocumentPolicyError("Open-access evidence is required.")
        if evidence.provider is not request.provider:
            raise DocumentPolicyError("Open-access evidence provider does not match.")
        if evidence.source_record_id != request.repository_id:
            raise DocumentPolicyError("Open-access evidence record does not match.")
        allowed_urls = _LICENSE_URLS.get(evidence.access_assertion, frozenset())
        if evidence.license_url not in allowed_urls:
            raise DocumentPolicyError("Open-access license evidence is not approved.")
        if (
            evidence.access_assertion is AccessAssertion.OPEN_ACCESS
            and evidence.license_url != _PROVIDER_OPEN_ACCESS_URL.get(request.provider)
        ):
            raise DocumentPolicyError("Open-access evidence does not match the provider.")

    @staticmethod
    def _validate_common(request: DocumentRequest) -> None:
        values = (request.repository_id, request.exact_pdf_path)
        if any(value != value.strip() or not value for value in values):
            raise DocumentPolicyError("Document identifier or path is not canonical.")
        path = request.exact_pdf_path
        if (
            len(path) > 256
            or "%" in path
            or "\\" in path
            or "//" in path
            or "/./" in path
            or "/../" in path
            or "?" in path
            or "#" in path
            or "@" in path
            or any(ord(character) < 0x20 or ord(character) == 0x7F for character in path)
        ):
            raise DocumentPolicyError("Document path is not canonical.")

    @staticmethod
    def _arxiv_target(repository_id: str, path: str) -> ApprovedDocumentTarget:
        if not _ARXIV_ID.fullmatch(repository_id):
            raise DocumentPolicyError("arXiv identifier is not canonical.")
        match = _ARXIV_PATH.fullmatch(path)
        if match is None or match.group("identifier") != repository_id:
            raise DocumentPolicyError("arXiv PDF path does not match the record.")
        return ApprovedDocumentTarget(DocumentProvider.ARXIV, "arxiv.org", path)

    @staticmethod
    def _pmc_target(repository_id: str, path: str) -> ApprovedDocumentTarget:
        if not _PMC_ID.fullmatch(repository_id):
            raise DocumentPolicyError("PMC identifier is not canonical.")
        match = _PMC_PATH.fullmatch(path)
        if match is None or match.group("identifier") != repository_id:
            raise DocumentPolicyError("PMC PDF path does not match the record.")
        return ApprovedDocumentTarget(DocumentProvider.PMC, "ftp.ncbi.nlm.nih.gov", path)


DOCUMENT_POLICY = DocumentPolicy()
