from __future__ import annotations

import asyncio
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Protocol

from litehouse.infrastructure.fetch.models import FetchError, FetchResult
from litehouse.infrastructure.sources.base import validated_search_term
from litehouse.infrastructure.sources.profile import ResearchSearchProfile


class SearchConnector(Protocol):
    SOURCE: str

    async def search(self, search_term: str) -> FetchResult: ...


@dataclass(frozen=True, slots=True)
class SourceSearchBatch:
    results: tuple[FetchResult, ...]

    @property
    def accepted_sources(self) -> tuple[str, ...]:
        return tuple(
            result.receipt.source
            for result in self.results
            if result.receipt is not None
        )

    @property
    def failed_sources(self) -> tuple[str, ...]:
        return tuple(
            result.error.source
            for result in self.results
            if result.error is not None
        )


class SourceSearchCoordinator:
    def __init__(self, connectors: Iterable[SearchConnector]) -> None:
        self._connectors = tuple(connectors)
        if not self._connectors:
            raise ValueError("At least one official source connector is required.")
        sources = tuple(connector.SOURCE for connector in self._connectors)
        if len(set(sources)) != len(sources):
            raise ValueError("Official source connectors must have unique names.")

    async def search(self, search_term: str) -> SourceSearchBatch:
        return await self.search_selected(
            search_term,
            sources=tuple(connector.SOURCE for connector in self._connectors),
        )

    async def search_selected(
        self,
        search_term: str,
        *,
        sources: tuple[str, ...],
    ) -> SourceSearchBatch:
        normalized = validated_search_term(search_term)
        if not sources or len(set(sources)) != len(sources):
            raise ValueError("Selected official sources must be non-empty and unique.")
        requested = frozenset(sources)
        available = {connector.SOURCE for connector in self._connectors}
        if not requested <= available:
            raise ValueError("An unavailable official source was selected.")
        selected = tuple(
            connector for connector in self._connectors if connector.SOURCE in requested
        )
        results = await asyncio.gather(
            *(self._search_one(connector, normalized) for connector in selected)
        )
        return SourceSearchBatch(results=tuple(results))

    async def search_profile(
        self,
        profile: ResearchSearchProfile,
        *,
        include_background: bool = False,
    ) -> SourceSearchBatch:
        return await self.search(
            profile.build_search_term(include_background=include_background)
        )

    @staticmethod
    async def _search_one(
        connector: SearchConnector,
        search_term: str,
    ) -> FetchResult:
        try:
            return await connector.search(search_term)
        except Exception:
            return FetchResult(
                error=FetchError(
                    source=connector.SOURCE,
                    code="source_connector_error",
                    message="The official source connector failed.",
                    retryable=False,
                    partial_source=True,
                )
            )
