from __future__ import annotations

from litehouse.infrastructure.fetch.client import OfficialSourceFetcher
from litehouse.infrastructure.fetch.models import FetchRequest, FetchResult
from litehouse.infrastructure.sources.base import official_request, validated_search_term


class CrossrefConnector:
    SOURCE = "crossref"
    ENDPOINT_NAME = "works"
    ENDPOINT_URL = "https://api.crossref.org/works"

    def __init__(self, fetcher: OfficialSourceFetcher | None = None) -> None:
        self._fetcher = fetcher or OfficialSourceFetcher()

    def build_search_request(
        self,
        search_term: str,
        *,
        rows: int = 25,
        offset: int = 0,
    ) -> FetchRequest:
        if not 1 <= rows <= 1000:
            raise ValueError("Crossref row count must be between 1 and 1000.")
        if offset < 0:
            raise ValueError("Crossref offset must not be negative.")
        return official_request(
            source=self.SOURCE,
            endpoint_name=self.ENDPOINT_NAME,
            endpoint_url=self.ENDPOINT_URL,
            parameters=(
                ("query", validated_search_term(search_term)),
                ("rows", str(rows)),
                ("offset", str(offset)),
            ),
        )

    async def search(
        self,
        search_term: str,
        *,
        rows: int = 25,
        offset: int = 0,
    ) -> FetchResult:
        request = self.build_search_request(search_term, rows=rows, offset=offset)
        return await self._fetcher.fetch(request)
