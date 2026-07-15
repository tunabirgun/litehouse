from __future__ import annotations

from litehouse.infrastructure.fetch.client import OfficialSourceFetcher
from litehouse.infrastructure.fetch.models import FetchRequest, FetchResult
from litehouse.infrastructure.sources.base import official_request, validated_search_term


class LibraryOfCongressConnector:
    SOURCE = "library_of_congress"
    ENDPOINT_NAME = "search"
    ENDPOINT_URL = "https://www.loc.gov/search/"

    def __init__(self, fetcher: OfficialSourceFetcher | None = None) -> None:
        self._fetcher = fetcher or OfficialSourceFetcher()

    def build_search_request(
        self,
        search_term: str,
        *,
        page: int = 1,
        count: int = 25,
    ) -> FetchRequest:
        if page < 1:
            raise ValueError("Library of Congress page must be positive.")
        if not 1 <= count <= 1000:
            raise ValueError("Library of Congress result count must be between 1 and 1000.")
        return official_request(
            source=self.SOURCE,
            endpoint_name=self.ENDPOINT_NAME,
            endpoint_url=self.ENDPOINT_URL,
            parameters=(
                ("q", validated_search_term(search_term)),
                ("fo", "json"),
                ("at", "results,pagination"),
                ("c", str(count)),
                ("sp", str(page)),
            ),
        )

    async def search(
        self,
        search_term: str,
        *,
        page: int = 1,
        count: int = 25,
    ) -> FetchResult:
        request = self.build_search_request(search_term, page=page, count=count)
        return await self._fetcher.fetch(request)
