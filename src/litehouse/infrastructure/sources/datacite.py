from __future__ import annotations

from litehouse.infrastructure.fetch.client import OfficialSourceFetcher
from litehouse.infrastructure.fetch.models import FetchRequest, FetchResult
from litehouse.infrastructure.sources.base import official_request, validated_search_term


class DataCiteConnector:
    SOURCE = "datacite"
    ENDPOINT_NAME = "dois"
    ENDPOINT_URL = "https://api.datacite.org/dois"

    def __init__(self, fetcher: OfficialSourceFetcher | None = None) -> None:
        self._fetcher = fetcher or OfficialSourceFetcher()

    def build_search_request(
        self,
        search_term: str,
        *,
        page: int = 1,
        page_size: int = 25,
    ) -> FetchRequest:
        if page < 1:
            raise ValueError("DataCite page must be positive.")
        if not 1 <= page_size <= 1000:
            raise ValueError("DataCite page size must be between 1 and 1000.")
        return official_request(
            source=self.SOURCE,
            endpoint_name=self.ENDPOINT_NAME,
            endpoint_url=self.ENDPOINT_URL,
            parameters=(
                ("query", validated_search_term(search_term)),
                ("page[number]", str(page)),
                ("page[size]", str(page_size)),
                ("disable-facets", "true"),
            ),
            accepted_mime_types=frozenset(
                {"application/json", "application/vnd.api+json"}
            ),
        )

    async def search(
        self,
        search_term: str,
        *,
        page: int = 1,
        page_size: int = 25,
    ) -> FetchResult:
        request = self.build_search_request(search_term, page=page, page_size=page_size)
        return await self._fetcher.fetch(request)
