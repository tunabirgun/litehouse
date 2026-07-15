from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import UTC, date, datetime
from html.parser import HTMLParser
from typing import cast
from urllib.parse import urlsplit

from litehouse.infrastructure.fetch.models import FetchResult
from litehouse.infrastructure.literature.models import (
    LiteratureRecord,
    PublicationDatePrecision,
)

MAX_RECORDS_PER_RESPONSE = 1000
MAX_TEXT_LENGTH = 100_000
_WHITESPACE = re.compile(r"\s+")


class LiteratureParseError(ValueError):
    pass


class _PlainTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def _plain_text(value: object, *, max_length: int = MAX_TEXT_LENGTH) -> str | None:
    if not isinstance(value, str):
        return None
    parser = _PlainTextParser()
    try:
        parser.feed(value[: max_length * 2])
        candidate = " ".join(parser.parts)
    except Exception:
        candidate = value
    normalized = _WHITESPACE.sub(" ", candidate).strip()
    return normalized[:max_length] or None


def _string(value: object, *, max_length: int = 4000) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = _WHITESPACE.sub(" ", value).strip()
    return normalized[:max_length] or None


def _mapping(value: object) -> Mapping[str, object]:
    return cast(Mapping[str, object], value) if isinstance(value, dict) else {}


def _sequence(value: object) -> Sequence[object]:
    return cast(Sequence[object], value) if isinstance(value, list) else ()


def _first_string(value: object) -> str | None:
    if isinstance(value, list):
        for candidate in value:
            normalized = _string(candidate)
            if normalized:
                return normalized
        return None
    return _string(value)


def _integer(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and value.isascii() and value.isdigit():
        return int(value)
    return None


def _url(value: object) -> str | None:
    candidate = _string(value, max_length=4096)
    if not candidate:
        return None
    parsed = urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username is not None or parsed.password is not None:
        return None
    return candidate


def _open_license_url(value: object) -> str | None:
    candidate = _url(value)
    if not candidate:
        return None
    hostname = (urlsplit(candidate).hostname or "").casefold()
    if hostname in {
        "creativecommons.org",
        "www.creativecommons.org",
        "opendatacommons.org",
        "www.opendatacommons.org",
        "rightsstatements.org",
        "www.rightsstatements.org",
    }:
        return candidate
    return None


def _date(value: object) -> tuple[date | None, PublicationDatePrecision | None]:
    candidate = _string(value, max_length=32)
    if not candidate:
        return None, None
    parts = candidate[:10].split("-")
    try:
        if len(parts) >= 3:
            return date(int(parts[0]), int(parts[1]), int(parts[2])), PublicationDatePrecision.DAY
        if len(parts) == 2:
            return date(int(parts[0]), int(parts[1]), 1), PublicationDatePrecision.MONTH
        return date(int(parts[0]), 1, 1), PublicationDatePrecision.YEAR
    except (ValueError, IndexError):
        return None, None


def _date_parts(value: object) -> tuple[date | None, PublicationDatePrecision | None]:
    outer = _sequence(value)
    parts = _sequence(outer[0]) if outer else ()
    numbers = [part for part in parts if isinstance(part, int) and not isinstance(part, bool)]
    try:
        if len(numbers) >= 3:
            return date(numbers[0], numbers[1], numbers[2]), PublicationDatePrecision.DAY
        if len(numbers) == 2:
            return date(numbers[0], numbers[1], 1), PublicationDatePrecision.MONTH
        if len(numbers) == 1:
            return date(numbers[0], 1, 1), PublicationDatePrecision.YEAR
    except ValueError:
        pass
    return None, None


def _identifier(namespace: str, value: object) -> tuple[str, str] | None:
    candidate = _string(value, max_length=512)
    if not candidate:
        return None
    if namespace == "doi":
        candidate = (
            candidate.removeprefix("https://doi.org/").removeprefix("http://doi.org/").lower()
        )
    return namespace, candidate


def _identifiers(values: Iterable[tuple[str, object]]) -> tuple[tuple[str, str], ...]:
    collected: dict[str, str] = {}
    for namespace, value in values:
        item = _identifier(namespace, value)
        if item:
            collected.setdefault(item[0], item[1])
    return tuple(sorted(collected.items()))


def _contributors(values: Iterable[object]) -> tuple[str, ...]:
    collected: list[str] = []
    for value in values:
        name = _string(value, max_length=512)
        if name and name.casefold() not in {item.casefold() for item in collected}:
            collected.append(name)
        if len(collected) >= 200:
            break
    return tuple(collected)


def _record(
    *,
    source: str,
    source_record_id: object,
    title: object,
    kind: object,
    identifiers: tuple[tuple[str, str], ...],
    contributors: tuple[str, ...],
    publication: tuple[date | None, PublicationDatePrecision | None],
    language: object,
    venue: object,
    abstract: object,
    landing_url: object,
    open_full_text_url: object,
    license_url: object,
    citation_count: object,
    content_sha256: str,
    retrieved_at: datetime,
) -> LiteratureRecord | None:
    normalized_title = _plain_text(title, max_length=4000)
    normalized_id = _string(source_record_id, max_length=1000)
    if not normalized_title or not normalized_id:
        return None
    return LiteratureRecord(
        source=source,
        source_record_id=normalized_id,
        title=normalized_title,
        kind=_string(kind, max_length=100) or "other",
        identifiers=identifiers,
        contributors=contributors,
        publication_date=publication[0],
        publication_date_precision=publication[1],
        language=_string(language, max_length=64),
        venue=_plain_text(venue, max_length=1000),
        abstract=_plain_text(abstract),
        landing_url=_url(landing_url),
        open_full_text_url=_url(open_full_text_url),
        license_url=_url(license_url),
        citation_count=_integer(citation_count),
        content_sha256=content_sha256,
        retrieved_at=retrieved_at,
    )


def _openalex(
    payload: Mapping[str, object], sha: str, retrieved: datetime
) -> list[LiteratureRecord]:
    records: list[LiteratureRecord] = []
    for raw in _sequence(payload.get("results"))[:MAX_RECORDS_PER_RESPONSE]:
        item = _mapping(raw)
        authors = (
            _mapping(_mapping(authorship).get("author")).get("display_name")
            for authorship in _sequence(item.get("authorships"))
        )
        primary_location = _mapping(item.get("primary_location"))
        source = _mapping(primary_location.get("source"))
        open_access = _mapping(item.get("open_access"))
        abstract = _openalex_abstract(item.get("abstract_inverted_index"))
        record = _record(
            source="openalex",
            source_record_id=item.get("id"),
            title=item.get("title") or item.get("display_name"),
            kind=item.get("type"),
            identifiers=_identifiers((("doi", item.get("doi")), ("openalex", item.get("id")))),
            contributors=_contributors(authors),
            publication=_date(item.get("publication_date")),
            language=item.get("language"),
            venue=source.get("display_name"),
            abstract=abstract,
            landing_url=primary_location.get("landing_page_url") or item.get("id"),
            open_full_text_url=open_access.get("oa_url")
            if open_access.get("is_oa") is True
            else None,
            license_url=primary_location.get("license"),
            citation_count=item.get("cited_by_count"),
            content_sha256=sha,
            retrieved_at=retrieved,
        )
        if record:
            records.append(record)
    return records


def _openalex_abstract(value: object) -> str | None:
    inverted = _mapping(value)
    positions: list[tuple[int, str]] = []
    for word, raw_positions in inverted.items():
        if not isinstance(word, str):
            continue
        for position in _sequence(raw_positions):
            if isinstance(position, int) and 0 <= position < 30_000:
                positions.append((position, word))
                if len(positions) >= 30_000:
                    break
    positions.sort(key=lambda pair: pair[0])
    return _plain_text(" ".join(word for _, word in positions)) if positions else None


def _crossref(
    payload: Mapping[str, object], sha: str, retrieved: datetime
) -> list[LiteratureRecord]:
    records: list[LiteratureRecord] = []
    message = _mapping(payload.get("message"))
    for raw in _sequence(message.get("items"))[:MAX_RECORDS_PER_RESPONSE]:
        item = _mapping(raw)
        author_names = []
        for raw_author in _sequence(item.get("author")):
            author = _mapping(raw_author)
            name = " ".join(
                part
                for part in (_string(author.get("given")), _string(author.get("family")))
                if part
            )
            author_names.append(name or author.get("name"))
        publication = _mapping(
            item.get("published") or item.get("published-print") or item.get("issued")
        )
        licenses = [_mapping(value) for value in _sequence(item.get("license"))]
        record = _record(
            source="crossref",
            source_record_id=item.get("DOI") or item.get("URL"),
            title=_first_string(item.get("title")),
            kind=item.get("type"),
            identifiers=_identifiers((("doi", item.get("DOI")),)),
            contributors=_contributors(author_names),
            publication=_date_parts(publication.get("date-parts")),
            language=item.get("language"),
            venue=_first_string(item.get("container-title")),
            abstract=item.get("abstract"),
            landing_url=item.get("URL"),
            # Crossref links can be text-mining links without being open access.
            # They must never be treated as reusable full text without separate OA evidence.
            open_full_text_url=None,
            license_url=licenses[0].get("URL") if licenses else None,
            citation_count=item.get("is-referenced-by-count"),
            content_sha256=sha,
            retrieved_at=retrieved,
        )
        if record:
            records.append(record)
    return records


def _europe_pmc(
    payload: Mapping[str, object], sha: str, retrieved: datetime
) -> list[LiteratureRecord]:
    records: list[LiteratureRecord] = []
    result_list = _mapping(payload.get("resultList"))
    for raw in _sequence(result_list.get("result"))[:MAX_RECORDS_PER_RESPONSE]:
        item = _mapping(raw)
        author_list = _mapping(item.get("authorList"))
        names = (
            _mapping(author).get("fullName") for author in _sequence(author_list.get("author"))
        )
        full_text_list = _mapping(item.get("fullTextUrlList"))
        full_text_urls = [_mapping(url) for url in _sequence(full_text_list.get("fullTextUrl"))]
        pdf_url = next(
            (url.get("url") for url in full_text_urls if url.get("documentStyle") == "pdf"), None
        )
        record = _record(
            source="europe_pmc",
            source_record_id=item.get("id") or item.get("pmid") or item.get("pmcid"),
            title=item.get("title"),
            kind=item.get("pubType") or "article",
            identifiers=_identifiers(
                (("doi", item.get("doi")), ("pmid", item.get("pmid")), ("pmcid", item.get("pmcid")))
            ),
            contributors=_contributors(names),
            publication=_date(item.get("firstPublicationDate") or item.get("firstIndexDate")),
            language=item.get("language"),
            venue=item.get("journalTitle"),
            abstract=item.get("abstractText"),
            landing_url=f"https://europepmc.org/article/MED/{item.get('pmid')}"
            if item.get("pmid")
            else None,
            open_full_text_url=pdf_url if item.get("isOpenAccess") in {"Y", True} else None,
            license_url=item.get("license"),
            citation_count=item.get("citedByCount"),
            content_sha256=sha,
            retrieved_at=retrieved,
        )
        if record:
            records.append(record)
    return records


def _semantic_scholar(
    payload: Mapping[str, object], sha: str, retrieved: datetime
) -> list[LiteratureRecord]:
    records: list[LiteratureRecord] = []
    for raw in _sequence(payload.get("data"))[:MAX_RECORDS_PER_RESPONSE]:
        item = _mapping(raw)
        external = _mapping(item.get("externalIds"))
        authors = (_mapping(author).get("name") for author in _sequence(item.get("authors")))
        open_pdf = _mapping(item.get("openAccessPdf"))
        publication = _date(item.get("publicationDate"))
        if publication[0] is None and isinstance(item.get("year"), int):
            publication = _date(str(item["year"]))
        publication_types = _sequence(item.get("publicationTypes"))
        record = _record(
            source="semantic_scholar",
            source_record_id=item.get("paperId"),
            title=item.get("title"),
            kind=_first_string(publication_types) or "article",
            identifiers=_identifiers(
                (
                    ("doi", external.get("DOI")),
                    ("pmid", external.get("PubMed")),
                    ("arxiv", external.get("ArXiv")),
                )
            ),
            contributors=_contributors(authors),
            publication=publication,
            language=None,
            venue=item.get("venue"),
            abstract=item.get("abstract"),
            landing_url=item.get("url"),
            open_full_text_url=open_pdf.get("url"),
            license_url=open_pdf.get("license"),
            citation_count=item.get("citationCount"),
            content_sha256=sha,
            retrieved_at=retrieved,
        )
        if record:
            records.append(record)
    return records


def _library_of_congress(
    payload: Mapping[str, object], sha: str, retrieved: datetime
) -> list[LiteratureRecord]:
    records: list[LiteratureRecord] = []
    for raw in _sequence(payload.get("results"))[:MAX_RECORDS_PER_RESPONSE]:
        item = _mapping(raw)
        parts = [_mapping(part) for part in _sequence(item.get("partof"))]
        record = _record(
            source="library_of_congress",
            source_record_id=item.get("id") or item.get("url"),
            title=item.get("title"),
            kind=_first_string(item.get("type"))
            or item.get("original_format")
            or "archival_document",
            identifiers=_identifiers((("lccn", _first_string(item.get("number"))),)),
            contributors=_contributors(_sequence(item.get("contributor"))),
            publication=_date(item.get("date")),
            language=_first_string(item.get("language")),
            venue=parts[0].get("title") if parts else None,
            abstract=_first_string(item.get("description")),
            landing_url=item.get("id") or item.get("url"),
            open_full_text_url=None,
            license_url=None,
            citation_count=None,
            content_sha256=sha,
            retrieved_at=retrieved,
        )
        if record:
            records.append(record)
    return records


def _datacite(
    payload: Mapping[str, object], sha: str, retrieved: datetime
) -> list[LiteratureRecord]:
    records: list[LiteratureRecord] = []
    for raw in _sequence(payload.get("data"))[:MAX_RECORDS_PER_RESPONSE]:
        item = _mapping(raw)
        attributes = _mapping(item.get("attributes"))
        titles = [_mapping(title) for title in _sequence(attributes.get("titles"))]
        creators = [_mapping(creator) for creator in _sequence(attributes.get("creators"))]
        descriptions = [
            _mapping(description) for description in _sequence(attributes.get("descriptions"))
        ]
        abstract = next(
            (
                description.get("description")
                for description in descriptions
                if description.get("descriptionType") == "Abstract"
            ),
            None,
        )
        rights = [_mapping(right) for right in _sequence(attributes.get("rightsList"))]
        content_urls = _sequence(attributes.get("contentUrl"))
        types = _mapping(attributes.get("types"))
        publication = _date(attributes.get("published") or attributes.get("publicationYear"))
        open_license = _open_license_url(rights[0].get("rightsUri")) if rights else None
        record = _record(
            source="datacite",
            source_record_id=item.get("id") or attributes.get("doi"),
            title=titles[0].get("title") if titles else None,
            kind=types.get("resourceTypeGeneral") or types.get("resourceType") or "other",
            identifiers=_identifiers((("doi", attributes.get("doi") or item.get("id")),)),
            contributors=_contributors(creator.get("name") for creator in creators),
            publication=publication,
            language=attributes.get("language"),
            venue=attributes.get("publisher"),
            abstract=abstract,
            landing_url=attributes.get("url"),
            open_full_text_url=content_urls[0] if content_urls and open_license else None,
            license_url=open_license,
            citation_count=attributes.get("citationCount"),
            content_sha256=sha,
            retrieved_at=retrieved,
        )
        if record:
            records.append(record)
    return records


_PARSERS: dict[str, Callable[[Mapping[str, object], str, datetime], list[LiteratureRecord]]] = {
    "openalex": _openalex,
    "crossref": _crossref,
    "europe_pmc": _europe_pmc,
    "semantic_scholar": _semantic_scholar,
    "library_of_congress": _library_of_congress,
    "datacite": _datacite,
}


def parse_source_result(result: FetchResult) -> tuple[LiteratureRecord, ...]:
    if not result.accepted or result.payload is None or result.receipt is None:
        raise LiteratureParseError("Only accepted source responses can be parsed.")
    parser = _PARSERS.get(result.receipt.source)
    if parser is None:
        raise LiteratureParseError("The accepted source is not supported by the normalizer.")
    try:
        payload: object = json.loads(result.payload)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise LiteratureParseError("The source response is not valid UTF-8 JSON.") from error
    if not isinstance(payload, dict):
        raise LiteratureParseError("The source response root must be a JSON object.")
    retrieved = result.receipt.retrieved_at.astimezone(UTC)
    return tuple(
        parser(cast(Mapping[str, object], payload), result.receipt.content_sha256, retrieved)
    )
