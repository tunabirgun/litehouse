from __future__ import annotations

from litehouse.infrastructure.fetch.client import OfficialSourceFetcher
from litehouse.infrastructure.fetch.models import FetchRequest, FetchResult
from litehouse.infrastructure.sources.base import official_request, validated_search_term


class OpenAlexConnector:
    SOURCE = "openalex"
    ENDPOINT_NAME = "works"
    ENDPOINT_URL = "https://api.openalex.org/works"

    def __init__(self, fetcher: OfficialSourceFetcher | None = None) -> None:
        self._fetcher = fetcher or OfficialSourceFetcher()

    def build_search_request(
        self,
        search_term: str,
        *,
        page: int = 1,
        per_page: int = 25,
    ) -> FetchRequest:
        if page < 1:
            raise ValueError("OpenAlex page must be positive.")
        if not 1 <= per_page <= 200:
            raise ValueError("OpenAlex page size must be between 1 and 200.")
        return official_request(
            source=self.SOURCE,
            endpoint_name=self.ENDPOINT_NAME,
            endpoint_url=self.ENDPOINT_URL,
            parameters=(
                ("search", validated_search_term(search_term)),
                ("page", str(page)),
                ("per-page", str(per_page)),
            ),
        )

    async def search(
        self,
        search_term: str,
        *,
        page: int = 1,
        per_page: int = 25,
    ) -> FetchResult:
        request = self.build_search_request(search_term, page=page, per_page=per_page)
        return await self._fetcher.fetch(request)
