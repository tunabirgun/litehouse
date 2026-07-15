from __future__ import annotations

from urllib.parse import urlencode

from litehouse.infrastructure.fetch.models import FetchRequest

MAX_SEARCH_LENGTH = 1000
DEFAULT_MAX_BYTES = 5 * 1024 * 1024


def validated_search_term(search_term: str) -> str:
    normalized = search_term.strip()
    if not normalized:
        raise ValueError("Search term must not be empty.")
    if len(normalized) > MAX_SEARCH_LENGTH:
        raise ValueError("Search term is too long.")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in normalized):
        raise ValueError("Search term contains control characters.")
    return normalized


def official_request(
    *,
    source: str,
    endpoint_name: str,
    endpoint_url: str,
    parameters: tuple[tuple[str, str], ...],
    accepted_mime_types: frozenset[str] = frozenset({"application/json"}),
) -> FetchRequest:
    query = urlencode(parameters, doseq=False, safe="")
    return FetchRequest(
        source=source,
        endpoint=endpoint_name,
        url=f"{endpoint_url}?{query}",
        accepted_mime_types=accepted_mime_types,
        max_bytes=DEFAULT_MAX_BYTES,
        redirect_limit=0,
    )
