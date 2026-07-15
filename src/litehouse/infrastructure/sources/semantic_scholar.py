from __future__ import annotations

from litehouse.infrastructure.fetch.client import OfficialSourceFetcher
from litehouse.infrastructure.fetch.models import FetchRequest, FetchResult
from litehouse.infrastructure.sources.base import official_request, validated_search_term


class SemanticScholarConnector:
    SOURCE = "semantic_scholar"
    ENDPOINT_NAME = "paper_search"
    ENDPOINT_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
    FIELDS = (
        "paperId,externalIds,title,authors,abstract,year,publicationDate,venue,"
        "publicationTypes,citationCount,openAccessPdf,url"
    )

    def __init__(self, fetcher: OfficialSourceFetcher | None = None) -> None:
        self._fetcher = fetcher or OfficialSourceFetcher()

    def build_search_request(
        self,
        search_term: str,
        *,
        limit: int = 25,
        offset: int = 0,
    ) -> FetchRequest:
        if not 1 <= limit <= 100:
            raise ValueError("Semantic Scholar result limit must be between 1 and 100.")
        if not 0 <= offset <= 9999:
            raise ValueError("Semantic Scholar offset must be between 0 and 9999.")
        return official_request(
            source=self.SOURCE,
            endpoint_name=self.ENDPOINT_NAME,
            endpoint_url=self.ENDPOINT_URL,
            parameters=(
                ("query", validated_search_term(search_term)),
                ("offset", str(offset)),
                ("limit", str(limit)),
                ("fields", self.FIELDS),
            ),
        )

    async def search(
        self,
        search_term: str,
        *,
        limit: int = 25,
        offset: int = 0,
    ) -> FetchResult:
        request = self.build_search_request(search_term, limit=limit, offset=offset)
        return await self._fetcher.fetch(request)
