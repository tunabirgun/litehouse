from __future__ import annotations

import hashlib
import re
import unicodedata
import uuid
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable, Sequence
from datetime import date

from litehouse.domain import (
    Contributor,
    EvidenceScope,
    EvidenceSegment,
    MetadataAssertion,
    Work,
    WorkIdentifier,
    WorkKind,
)
from litehouse.infrastructure.literature.models import (
    CanonicalLiteratureWork,
    LiteratureRecord,
    MetadataConflict,
)

_IDENTIFIER_PRIORITY = ("doi", "pmid", "pmcid", "arxiv", "isbn", "lccn", "openalex")
_SOURCE_PRIORITY = {
    "crossref": 0,
    "datacite": 1,
    "europe_pmc": 2,
    "openalex": 3,
    "semantic_scholar": 4,
    "library_of_congress": 5,
}
_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)
_UUID_NAMESPACE = uuid.UUID("2f8d0cf6-903b-4df8-b7aa-cc377cb35dd8")


def _normalized_title(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return " ".join(_NON_WORD.sub(" ", normalized).split())


def _record_order(record: LiteratureRecord) -> tuple[int, str, str]:
    return (_SOURCE_PRIORITY.get(record.source, 100), record.source, record.source_record_id)


def _identity_candidates(record: LiteratureRecord) -> tuple[str, ...]:
    identifiers = record.identifier_map
    candidates = tuple(
        f"{namespace}:{identifiers[namespace]}"
        for namespace in _IDENTIFIER_PRIORITY
        if namespace in identifiers
    )
    title = _normalized_title(record.title)
    year = record.publication_date.year if record.publication_date else "unknown"
    return (*candidates, f"title:{title}|year:{year}")


class _DisjointSet:
    def __init__(self, size: int) -> None:
        self.parent = list(range(size))

    def find(self, item: int) -> int:
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[max(left_root, right_root)] = min(left_root, right_root)


def _clusters(records: Sequence[LiteratureRecord]) -> tuple[tuple[LiteratureRecord, ...], ...]:
    disjoint = _DisjointSet(len(records))
    seen: dict[str, int] = {}
    for index, record in enumerate(records):
        for candidate in _identity_candidates(record)[:-1]:
            previous = seen.setdefault(candidate, index)
            if previous != index:
                disjoint.union(previous, index)

    title_buckets: dict[str, list[int]] = defaultdict(list)
    for index, record in enumerate(records):
        title_buckets[_identity_candidates(record)[-1]].append(index)
    for indexes in title_buckets.values():
        roots = {disjoint.find(index) for index in indexes}
        strong_roots = {
            root
            for root in roots
            if any(
                _identity_candidates(records[index])[:-1]
                for index in indexes
                if disjoint.find(index) == root
            )
        }
        weak_roots = roots - strong_roots
        if len(strong_roots) == 1:
            target = next(iter(strong_roots))
            for root in weak_roots:
                disjoint.union(target, root)
        elif not strong_roots and roots:
            target = min(roots)
            for root in roots:
                disjoint.union(target, root)
        elif weak_roots:
            target = min(weak_roots)
            for root in weak_roots:
                disjoint.union(target, root)

    grouped: dict[int, list[LiteratureRecord]] = defaultdict(list)
    for index, record in enumerate(records):
        grouped[disjoint.find(index)].append(record)
    return tuple(
        tuple(sorted(group, key=_record_order))
        for _, group in sorted(grouped.items(), key=lambda pair: pair[0])
    )


def _identity_key(records: Sequence[LiteratureRecord]) -> str:
    candidates = {candidate for record in records for candidate in _identity_candidates(record)}
    for namespace in _IDENTIFIER_PRIORITY:
        matches = sorted(
            candidate for candidate in candidates if candidate.startswith(f"{namespace}:")
        )
        if matches:
            return matches[0]
    return sorted(candidate for candidate in candidates if candidate.startswith("title:"))[0]


def _work_kind(value: str) -> WorkKind:
    normalized = value.casefold().replace("-", "_").replace(" ", "_")
    if "preprint" in normalized or "posted_content" in normalized:
        return WorkKind.PREPRINT
    if "article" in normalized or "journal" in normalized:
        return WorkKind.ARTICLE
    if "chapter" in normalized:
        return WorkKind.CHAPTER
    if "book" in normalized or "monograph" in normalized:
        return WorkKind.BOOK
    if "thesis" in normalized or "dissertation" in normalized:
        return WorkKind.THESIS
    if "proceeding" in normalized or "conference" in normalized:
        return WorkKind.PROCEEDINGS_PAPER
    if "dataset" in normalized or normalized == "data":
        return WorkKind.DATASET
    if "software" in normalized:
        return WorkKind.SOFTWARE
    if "protocol" in normalized:
        return WorkKind.PROTOCOL
    if "standard" in normalized:
        return WorkKind.STANDARD
    if "policy" in normalized or "report" in normalized:
        return WorkKind.POLICY_DOCUMENT
    if "art" in normalized or "image" in normalized:
        return WorkKind.ARTWORK
    if "catalog" in normalized:
        return WorkKind.EXHIBITION_CATALOGUE
    if "score" in normalized or "music" in normalized:
        return WorkKind.SCORE
    if "performance" in normalized:
        return WorkKind.PERFORMANCE
    if "archive" in normalized or "collection" in normalized or "manuscript" in normalized:
        return WorkKind.ARCHIVAL_DOCUMENT
    return WorkKind.OTHER


def _consensus(
    records: Sequence[LiteratureRecord],
    getter: Callable[[LiteratureRecord], object | None],
    normalizer: Callable[[object], str],
) -> tuple[object | None, bool, tuple[str, ...]]:
    values = [(record, getter(record)) for record in records]
    present = [(record, value) for record, value in values if value is not None]
    if not present:
        return None, False, ()
    normalized = [normalizer(value) for _, value in present]
    counts = Counter(normalized)
    best_count = max(counts.values())
    best_keys = {key for key, count in counts.items() if count == best_count}
    selected_record, selected = next(
        (record, value)
        for record, value in sorted(present, key=lambda pair: _record_order(pair[0]))
        if normalizer(value) in best_keys
    )
    del selected_record
    return selected, best_count >= 2, tuple(sorted(set(normalized)))


def _field_conflict(
    field_name: str,
    records: Sequence[LiteratureRecord],
    getter: Callable[[LiteratureRecord], object | None],
    normalizer: Callable[[object], str],
) -> MetadataConflict | None:
    observed = [
        (record.source, normalizer(value))
        for record in records
        if (value := getter(record)) is not None
    ]
    values = tuple(sorted({value for _, value in observed}))
    if len(values) < 2:
        return None
    return MetadataConflict(
        field_name=field_name,
        values=values,
        sources=tuple(sorted({source for source, _ in observed})),
    )


def _assertions(work_id: str, records: Sequence[LiteratureRecord]) -> tuple[MetadataAssertion, ...]:
    assertions: list[MetadataAssertion] = []
    for record in records:
        fields: dict[str, object] = {
            "title": record.title,
            "kind": record.kind,
            "identifiers": dict(record.identifiers),
            "contributors": list(record.contributors),
            "access_level": record.access_level.value,
            "source_content_sha256": record.content_sha256,
        }
        if record.publication_date:
            fields["publication_date"] = record.publication_date.isoformat()
        if record.language:
            fields["language"] = record.language
        if record.venue:
            fields["venue"] = record.venue
        if record.abstract:
            fields["abstract_sha256"] = hashlib.sha256(record.abstract.encode()).hexdigest()
        if record.citation_count is not None:
            fields["citation_count"] = record.citation_count
        for field_name, value in sorted(fields.items()):
            assertion_id = str(
                uuid.uuid5(
                    _UUID_NAMESPACE,
                    f"assertion:{work_id}:{record.source}:{record.source_record_id}:{field_name}",
                )
            )
            assertions.append(
                MetadataAssertion(
                    id=assertion_id,
                    work_id=work_id,
                    field_name=field_name,
                    value=value,
                    source=record.source,
                    source_record_id=record.source_record_id,
                    observed_at=record.retrieved_at,
                )
            )
    return tuple(assertions)


def _evidence(work_id: str, records: Sequence[LiteratureRecord]) -> tuple[EvidenceSegment, ...]:
    segments: list[EvidenceSegment] = []
    seen_hashes: set[str] = set()
    for record in records:
        if not record.abstract:
            continue
        digest = hashlib.sha256(record.abstract.encode()).hexdigest()
        if digest in seen_hashes:
            continue
        seen_hashes.add(digest)
        evidence_id = str(
            uuid.uuid5(
                _UUID_NAMESPACE,
                f"evidence:{work_id}:{record.source}:{record.source_record_id}:{digest}",
            )
        )
        segments.append(
            EvidenceSegment(
                id=evidence_id,
                work_id=work_id,
                text=record.abstract,
                locator=(
                    f"{record.source} abstract; record {record.source_record_id}; "
                    f"response SHA-256 {record.content_sha256}"
                ),
                scope=EvidenceScope.ABSTRACT,
            )
        )
    return tuple(segments)


def _canonicalize(records: Sequence[LiteratureRecord]) -> CanonicalLiteratureWork:
    identity_key = _identity_key(records)
    work_id = str(uuid.uuid5(_UUID_NAMESPACE, f"work:{identity_key}"))
    title_value, title_matched, _ = _consensus(
        records,
        lambda record: record.title,
        lambda value: _normalized_title(str(value)),
    )
    title = str(title_value) if title_value is not None else None
    publication_date_value, date_matched, _ = _consensus(
        records,
        lambda record: record.publication_date,
        lambda value: cast_date(value).isoformat(),
    )
    publication_date = (
        cast_date(publication_date_value) if publication_date_value is not None else None
    )
    venue_value, venue_matched, _ = _consensus(
        records,
        lambda record: record.venue,
        lambda value: " ".join(str(value).casefold().split()),
    )
    venue = str(venue_value) if venue_value is not None else None
    language_value, language_matched, _ = _consensus(
        records,
        lambda record: record.language,
        lambda value: str(value).casefold(),
    )
    language = str(language_value) if language_value is not None else None
    abstract_value, abstract_matched, _ = _consensus(
        records,
        lambda record: record.abstract,
        lambda value: hashlib.sha256(str(value).encode()).hexdigest(),
    )
    abstract = str(abstract_value) if abstract_value is not None else None
    all_identifiers = sorted(
        {identifier for record in records for identifier in record.identifiers}
    )
    contributors = max(
        records, key=lambda record: (len(record.contributors), -_record_order(record)[0])
    )
    kind_record = min(records, key=_record_order)
    full_text_record = next((record for record in records if record.open_full_text_url), None)
    landing_record = next((record for record in records if record.landing_url), None)
    license_record = next((record for record in records if record.license_url), None)
    citations = [record.citation_count for record in records if record.citation_count is not None]
    work = Work(
        id=work_id,
        title=title or records[0].title,
        kind=_work_kind(kind_record.kind),
        identifiers=tuple(WorkIdentifier(namespace, value) for namespace, value in all_identifiers),
        contributors=tuple(
            Contributor(name=name, position=index)
            for index, name in enumerate(contributors.contributors)
        ),
    )
    field_conflicts = [
        conflict
        for conflict in (
            _field_conflict(
                "title",
                records,
                lambda record: record.title,
                lambda value: _normalized_title(str(value)),
            ),
            _field_conflict(
                "publication_date",
                records,
                lambda record: record.publication_date,
                lambda value: cast_date(value).isoformat(),
            ),
            _field_conflict(
                "language",
                records,
                lambda record: record.language,
                lambda value: str(value).casefold(),
            ),
            _field_conflict(
                "venue",
                records,
                lambda record: record.venue,
                lambda value: " ".join(str(value).casefold().split()),
            ),
        )
        if conflict is not None
    ]
    for namespace in _IDENTIFIER_PRIORITY:
        values = sorted(
            {
                record.identifier_map[namespace]
                for record in records
                if namespace in record.identifier_map
            }
        )
        if len(values) > 1:
            field_conflicts.append(
                MetadataConflict(
                    field_name=f"identifier.{namespace}",
                    values=tuple(values),
                    sources=tuple(
                        sorted(
                            {
                                record.source
                                for record in records
                                if namespace in record.identifier_map
                            }
                        )
                    ),
                )
            )
    conflicts = tuple(field_conflicts)
    matched = tuple(
        field_name
        for field_name, is_matched in (
            ("title", title_matched),
            ("publication_date", date_matched),
            ("venue", venue_matched),
            ("language", language_matched),
            ("abstract", abstract_matched),
        )
        if is_matched
    )
    return CanonicalLiteratureWork(
        identity_key=identity_key,
        work=work,
        records=tuple(records),
        assertions=_assertions(work_id, records),
        evidence_segments=_evidence(work_id, records),
        publication_date=publication_date,
        language=language,
        venue=venue,
        abstract=abstract,
        landing_url=landing_record.landing_url if landing_record else None,
        open_full_text_url=full_text_record.open_full_text_url if full_text_record else None,
        license_url=license_record.license_url if license_record else None,
        citation_count=max(citations) if citations else None,
        conflicts=conflicts,
        matched_fields=matched,
    )


def cast_date(value: object) -> date:
    if not isinstance(value, date):
        raise TypeError("Expected a publication date.")
    return value


def reconcile_records(records: Iterable[LiteratureRecord]) -> tuple[CanonicalLiteratureWork, ...]:
    unique: dict[tuple[str, str, str], LiteratureRecord] = {}
    for record in records:
        unique.setdefault((record.source, record.source_record_id, record.content_sha256), record)
    ordered = tuple(sorted(unique.values(), key=_record_order))
    return tuple(
        sorted(
            (_canonicalize(cluster) for cluster in _clusters(ordered)),
            key=lambda work: work.identity_key,
        )
    )
