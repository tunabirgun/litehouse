from __future__ import annotations

import json
import re
from collections.abc import Iterable, Sequence
from xml.etree import ElementTree

from litehouse.domain import Contributor, WorkIdentifier, WorkKind
from litehouse.infrastructure.exports.citations import citation_warnings
from litehouse.infrastructure.exports.models import (
    CitationStyle,
    ExportArtifact,
    ProvenanceRecord,
    ReferenceRecord,
)

_CSL_TYPES: dict[WorkKind, str] = {
    WorkKind.ARTICLE: "article-journal",
    WorkKind.PREPRINT: "article",
    WorkKind.BOOK: "book",
    WorkKind.CHAPTER: "chapter",
    WorkKind.THESIS: "thesis",
    WorkKind.PROCEEDINGS_PAPER: "paper-conference",
    WorkKind.ARCHIVAL_DOCUMENT: "manuscript",
    WorkKind.ARTWORK: "graphic",
    WorkKind.EXHIBITION_CATALOGUE: "book",
    WorkKind.PERFORMANCE: "motion_picture",
    WorkKind.SCORE: "musical_score",
    WorkKind.DATASET: "dataset",
    WorkKind.SOFTWARE: "software",
    WorkKind.PROTOCOL: "report",
    WorkKind.TRIAL: "article",
    WorkKind.POLICY_DOCUMENT: "report",
    WorkKind.STANDARD: "standard",
    WorkKind.OTHER: "document",
}

_RIS_TYPES: dict[WorkKind, str] = {
    WorkKind.ARTICLE: "JOUR",
    WorkKind.PREPRINT: "UNPB",
    WorkKind.BOOK: "BOOK",
    WorkKind.CHAPTER: "CHAP",
    WorkKind.THESIS: "THES",
    WorkKind.PROCEEDINGS_PAPER: "CPAPER",
    WorkKind.ARCHIVAL_DOCUMENT: "MANSCPT",
    WorkKind.ARTWORK: "ART",
    WorkKind.EXHIBITION_CATALOGUE: "BOOK",
    WorkKind.PERFORMANCE: "VIDEO",
    WorkKind.SCORE: "MUSIC",
    WorkKind.DATASET: "DATA",
    WorkKind.SOFTWARE: "COMP",
    WorkKind.PROTOCOL: "RPRT",
    WorkKind.TRIAL: "JOUR",
    WorkKind.POLICY_DOCUMENT: "RPRT",
    WorkKind.STANDARD: "STAND",
    WorkKind.OTHER: "GEN",
}

_BIBTEX_TYPES: dict[WorkKind, str] = {
    WorkKind.ARTICLE: "article",
    WorkKind.PREPRINT: "unpublished",
    WorkKind.BOOK: "book",
    WorkKind.CHAPTER: "incollection",
    WorkKind.THESIS: "phdthesis",
    WorkKind.PROCEEDINGS_PAPER: "inproceedings",
    WorkKind.ARCHIVAL_DOCUMENT: "unpublished",
    WorkKind.ARTWORK: "misc",
    WorkKind.EXHIBITION_CATALOGUE: "book",
    WorkKind.PERFORMANCE: "misc",
    WorkKind.SCORE: "misc",
    WorkKind.DATASET: "misc",
    WorkKind.SOFTWARE: "misc",
    WorkKind.PROTOCOL: "techreport",
    WorkKind.TRIAL: "article",
    WorkKind.POLICY_DOCUMENT: "techreport",
    WorkKind.STANDARD: "techreport",
    WorkKind.OTHER: "misc",
}

_BIBLATEX_TYPES = {
    **_BIBTEX_TYPES,
    WorkKind.ARCHIVAL_DOCUMENT: "unpublished",
    WorkKind.ARTWORK: "artwork",
    WorkKind.PERFORMANCE: "performance",
    WorkKind.SCORE: "music",
    WorkKind.DATASET: "dataset",
    WorkKind.SOFTWARE: "software",
    WorkKind.STANDARD: "standard",
}

_ENDNOTE_TYPES: dict[WorkKind, tuple[str, str]] = {
    WorkKind.ARTICLE: ("Journal Article", "17"),
    WorkKind.PREPRINT: ("Unpublished Work", "34"),
    WorkKind.BOOK: ("Book", "6"),
    WorkKind.CHAPTER: ("Book Section", "5"),
    WorkKind.THESIS: ("Thesis", "32"),
    WorkKind.PROCEEDINGS_PAPER: ("Conference Paper", "10"),
    WorkKind.ARCHIVAL_DOCUMENT: ("Manuscript", "36"),
    WorkKind.ARTWORK: ("Artwork", "0"),
    WorkKind.EXHIBITION_CATALOGUE: ("Book", "6"),
    WorkKind.PERFORMANCE: ("Audiovisual Material", "3"),
    WorkKind.SCORE: ("Music", "22"),
    WorkKind.DATASET: ("Dataset", "59"),
    WorkKind.SOFTWARE: ("Computer Program", "9"),
    WorkKind.PROTOCOL: ("Report", "27"),
    WorkKind.TRIAL: ("Journal Article", "17"),
    WorkKind.POLICY_DOCUMENT: ("Government Document", "12"),
    WorkKind.STANDARD: ("Standard", "31"),
    WorkKind.OTHER: ("Generic", "13"),
}


def _records(records: Iterable[ReferenceRecord]) -> tuple[ReferenceRecord, ...]:
    ordered = tuple(sorted(records, key=lambda record: record.work.id))
    ids = [record.work.id for record in ordered]
    if len(ids) != len(set(ids)):
        raise ValueError("Each exported Work ID must be unique.")
    return ordered


def _identifiers(record: ReferenceRecord) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = {}
    for identifier in sorted(
        record.work.identifiers, key=lambda item: (item.namespace, item.value)
    ):
        grouped.setdefault(identifier.namespace, []).append(identifier.value)
    return grouped


def _contributors(record: ReferenceRecord, role: str) -> tuple[Contributor, ...]:
    return tuple(
        contributor
        for contributor in sorted(record.work.contributors, key=lambda item: item.position)
        if contributor.role.casefold() == role
    )


def _native_identifier(identifiers: Sequence[WorkIdentifier], namespace: str) -> str | None:
    values = sorted(item.value for item in identifiers if item.namespace == namespace)
    return values[0] if values else None


def _provenance_text(provenance: ProvenanceRecord) -> str:
    parts = [
        f"source={provenance.source}",
        f"record={provenance.record_id}",
        f"retrieved={provenance.retrieved_at.isoformat()}",
    ]
    if provenance.url is not None:
        parts.append(f"url={provenance.url}")
    if provenance.sha256 is not None:
        parts.append(f"sha256={provenance.sha256}")
    return "; ".join(parts)


def _notes(record: ReferenceRecord) -> tuple[str, ...]:
    metadata = record.metadata
    notes: list[str] = []
    if metadata.license_name is not None or metadata.license_url is not None:
        license_text = metadata.license_name or "unspecified license"
        if metadata.license_url is not None:
            license_text = f"{license_text} ({metadata.license_url})"
        notes.append(f"License: {license_text}")
    provenance = sorted(
        metadata.provenance,
        key=lambda item: (
            item.source,
            item.record_id,
            item.retrieved_at,
            item.url or "",
            item.sha256 or "",
        ),
    )
    notes.extend(f"Provenance: {_provenance_text(item)}" for item in provenance)
    notes.extend(
        f"Attachment warning: {warning}" for warning in sorted(metadata.attachment_warnings)
    )
    native = {"doi", "isbn", "issn"}
    for namespace, values in _identifiers(record).items():
        if namespace not in native:
            notes.append(f"Identifier {namespace}: {', '.join(values)}")
        elif len(values) > 1:
            notes.append(f"Additional identifier {namespace}: {', '.join(values[1:])}")
    notes.extend(
        f"Contributor {item.role}: {item.name}"
        for item in record.work.contributors
        if item.role.casefold() not in {"author", "editor"}
    )
    return tuple(notes)


def _warnings(records: Sequence[ReferenceRecord]) -> tuple[str, ...]:
    warnings: list[str] = []
    for record in records:
        warnings.extend(
            f"{record.work.id}: {warning}" for warning in citation_warnings(record)
        )
        warnings.extend(
            f"{record.work.id}: {warning}"
            for warning in sorted(record.metadata.attachment_warnings)
        )
    return tuple(warnings)


def serialize_csl_json(
    records: Iterable[ReferenceRecord], *, style: CitationStyle
) -> ExportArtifact:
    ordered = _records(records)
    items: list[dict[str, object]] = []
    for record in ordered:
        metadata = record.metadata
        item: dict[str, object] = {
            "id": record.work.id,
            "type": _CSL_TYPES[record.work.kind],
            "title": record.work.title,
        }
        authors = _contributors(record, "author")
        editors = _contributors(record, "editor")
        if authors:
            item["author"] = [{"literal": contributor.name} for contributor in authors]
        if editors:
            item["editor"] = [{"literal": contributor.name} for contributor in editors]
        translators = _contributors(record, "translator")
        if translators:
            item["translator"] = [
                {"literal": contributor.name} for contributor in translators
            ]
        if metadata.issued is not None:
            item["issued"] = {"date-parts": [metadata.issued.date_parts]}
        optional_fields = {
            "container-title": metadata.container_title,
            "publisher": metadata.publisher,
            "publisher-place": metadata.publisher_place,
            "volume": metadata.volume,
            "issue": metadata.issue,
            "page": metadata.pages,
            "edition": metadata.edition,
            "language": metadata.language,
            "URL": metadata.url,
            "DOI": _native_identifier(record.work.identifiers, "doi"),
            "ISBN": _native_identifier(record.work.identifiers, "isbn"),
            "ISSN": _native_identifier(record.work.identifiers, "issn"),
        }
        item.update({key: value for key, value in optional_fields.items() if value is not None})
        notes = _notes(record)
        if notes:
            item["note"] = " | ".join(notes)
        items.append(item)
    return ExportArtifact(
        content=json.dumps(items, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        media_type="application/vnd.citationstyles.csl+json",
        file_extension="json",
        citation_style=style,
        warnings=_warnings(ordered),
    )


def _ris_line(tag: str, value: str) -> str:
    return f"{tag}  - {value.replace(chr(10), ' ').replace(chr(13), ' ')}"


def _page_parts(pages: str) -> tuple[str, str | None]:
    parts = re.split(r"\s*[-–—]\s*", pages, maxsplit=1)
    return parts[0], parts[1] if len(parts) == 2 else None


def serialize_ris(records: Iterable[ReferenceRecord], *, style: CitationStyle) -> ExportArtifact:
    ordered = _records(records)
    rendered: list[str] = []
    for record in ordered:
        metadata = record.metadata
        rendered.extend(
            [
                _ris_line("TY", _RIS_TYPES[record.work.kind]),
                _ris_line("ID", record.work.id),
                _ris_line("TI", record.work.title),
            ]
        )
        rendered.extend(_ris_line("AU", item.name) for item in _contributors(record, "author"))
        rendered.extend(_ris_line("ED", item.name) for item in _contributors(record, "editor"))
        if metadata.issued is not None:
            rendered.append(_ris_line("PY", str(metadata.issued.year)))
            rendered.append(_ris_line("DA", metadata.issued.isoformat))
        optional_tags = (
            ("T2", metadata.container_title),
            ("PB", metadata.publisher),
            ("CY", metadata.publisher_place),
            ("VL", metadata.volume),
            ("IS", metadata.issue),
            ("ET", metadata.edition),
            ("LA", metadata.language),
            ("UR", metadata.url),
            ("DO", _native_identifier(record.work.identifiers, "doi")),
        )
        rendered.extend(_ris_line(tag, value) for tag, value in optional_tags if value is not None)
        for namespace in ("isbn", "issn"):
            for value in _identifiers(record).get(namespace, []):
                rendered.append(_ris_line("SN", value))
        if metadata.pages is not None:
            start, end = _page_parts(metadata.pages)
            rendered.append(_ris_line("SP", start))
            if end is not None:
                rendered.append(_ris_line("EP", end))
        rendered.append(_ris_line("N1", f"Litehouse citation style metadata: {style.value}"))
        rendered.extend(_ris_line("N1", note) for note in _notes(record))
        rendered.extend(["ER  -", ""])
    return ExportArtifact(
        content="\n".join(rendered),
        media_type="application/x-research-info-systems",
        file_extension="ris",
        citation_style=style,
        warnings=_warnings(ordered),
    )


def _bib_escape(value: str) -> str:
    replacements = {
        "\\": r"\textbackslash{}",
        "{": r"\{",
        "}": r"\}",
        "#": r"\#",
        "$": r"\$",
        "%": r"\%",
        "&": r"\&",
        "_": r"\_",
        "^": r"\^{}",
        "~": r"\~{}",
    }
    return "".join(replacements.get(character, character) for character in value)


def _citation_key(work_id: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "_", work_id.casefold()).strip("_")
    if not normalized:
        normalized = "record"
    return f"litehouse_{normalized}"


def _bib_fields(record: ReferenceRecord, *, biblatex: bool) -> list[tuple[str, str]]:
    metadata = record.metadata
    fields: list[tuple[str, str]] = [("title", record.work.title)]
    authors = _contributors(record, "author")
    editors = _contributors(record, "editor")
    if authors:
        fields.append(("author", " and ".join(item.name for item in authors)))
    if editors:
        fields.append(("editor", " and ".join(item.name for item in editors)))
    if metadata.issued is not None:
        issued_value = metadata.issued.isoformat if biblatex else str(metadata.issued.year)
        fields.append(("date" if biblatex else "year", issued_value))
        if not biblatex and metadata.issued.month is not None:
            fields.append(("month", str(metadata.issued.month)))
    container_field = "journaltitle" if biblatex else "journal"
    if record.work.kind not in {WorkKind.ARTICLE, WorkKind.TRIAL}:
        container_field = "booktitle"
    optional_fields = (
        (container_field, metadata.container_title),
        ("publisher", metadata.publisher),
        ("location" if biblatex else "address", metadata.publisher_place),
        ("volume", metadata.volume),
        ("number", metadata.issue),
        ("pages", metadata.pages),
        ("edition", metadata.edition),
        ("language", metadata.language),
        ("url", metadata.url),
        ("doi", _native_identifier(record.work.identifiers, "doi")),
        ("isbn", _native_identifier(record.work.identifiers, "isbn")),
        ("issn", _native_identifier(record.work.identifiers, "issn")),
    )
    fields.extend((name, value) for name, value in optional_fields if value is not None)
    notes = list(_notes(record))
    if not biblatex and metadata.issued is not None and metadata.issued.day is not None:
        notes.append(f"Publication date: {metadata.issued.isoformat}")
    if notes:
        fields.append(("annotation" if biblatex else "note", " | ".join(notes)))
    return fields


def _serialize_bib(
    records: Iterable[ReferenceRecord], *, style: CitationStyle, biblatex: bool
) -> ExportArtifact:
    ordered = _records(records)
    types = _BIBLATEX_TYPES if biblatex else _BIBTEX_TYPES
    entries = [f"@comment{{litehouse-citation-style: {style.value}}}"]
    for record in ordered:
        fields = _bib_fields(record, biblatex=biblatex)
        lines = [f"@{types[record.work.kind]}{{{_citation_key(record.work.id)},"]
        lines.extend(
            f"  {name} = {{{_bib_escape(value)}}}{',' if index < len(fields) - 1 else ''}"
            for index, (name, value) in enumerate(fields)
        )
        lines.append("}")
        entries.append("\n".join(lines))
    return ExportArtifact(
        content="\n\n".join(entries) + "\n",
        media_type="application/x-biblatex" if biblatex else "application/x-bibtex",
        file_extension="bib",
        citation_style=style,
        warnings=_warnings(ordered),
    )


def serialize_bibtex(
    records: Iterable[ReferenceRecord], *, style: CitationStyle
) -> ExportArtifact:
    return _serialize_bib(records, style=style, biblatex=False)


def serialize_biblatex(
    records: Iterable[ReferenceRecord], *, style: CitationStyle
) -> ExportArtifact:
    return _serialize_bib(records, style=style, biblatex=True)


def _xml_text(parent: ElementTree.Element, tag: str, value: str | None) -> None:
    if value is not None:
        ElementTree.SubElement(parent, tag).text = value


def _xml_styled(parent: ElementTree.Element, tag: str, value: str | None) -> None:
    if value is None:
        return
    element = ElementTree.SubElement(parent, tag)
    ElementTree.SubElement(
        element,
        "style",
        {"face": "normal", "font": "default", "size": "100%"},
    ).text = value


def serialize_endnote_xml(
    records: Iterable[ReferenceRecord], *, style: CitationStyle
) -> ExportArtifact:
    ordered = _records(records)
    root = ElementTree.Element("xml")
    database = ElementTree.SubElement(root, "database", {"name": "Litehouse"})
    ElementTree.SubElement(database, "source-app", {"name": "Litehouse", "version": "0.1"})
    ElementTree.SubElement(database, "citation-style").text = style.value
    records_element = ElementTree.SubElement(database, "records")
    for record in ordered:
        metadata = record.metadata
        record_element = ElementTree.SubElement(records_element, "record")
        ElementTree.SubElement(record_element, "rec-number").text = record.work.id
        ref_name, ref_number = _ENDNOTE_TYPES[record.work.kind]
        ElementTree.SubElement(record_element, "ref-type", {"name": ref_name}).text = ref_number
        contributors = ElementTree.SubElement(record_element, "contributors")
        for role, tag in (("author", "authors"), ("editor", "secondary-authors")):
            people = _contributors(record, role)
            if people:
                people_element = ElementTree.SubElement(contributors, tag)
                for contributor in people:
                    ElementTree.SubElement(people_element, "author").text = contributor.name
        titles = ElementTree.SubElement(record_element, "titles")
        _xml_styled(titles, "title", record.work.title)
        _xml_styled(titles, "secondary-title", metadata.container_title)
        if metadata.issued is not None:
            dates = ElementTree.SubElement(record_element, "dates")
            ElementTree.SubElement(dates, "year").text = str(metadata.issued.year)
            ElementTree.SubElement(dates, "pub-dates").text = metadata.issued.isoformat
        _xml_text(record_element, "publisher", metadata.publisher)
        _xml_text(record_element, "pub-location", metadata.publisher_place)
        _xml_text(record_element, "volume", metadata.volume)
        _xml_text(record_element, "number", metadata.issue)
        _xml_text(record_element, "pages", metadata.pages)
        _xml_text(record_element, "edition", metadata.edition)
        _xml_text(record_element, "language", metadata.language)
        serials = [
            item.value
            for item in record.work.identifiers
            if item.namespace in {"isbn", "issn"}
        ]
        _xml_text(record_element, "isbn", "; ".join(sorted(serials)) or None)
        _xml_text(
            record_element,
            "electronic-resource-num",
            _native_identifier(record.work.identifiers, "doi"),
        )
        if metadata.url is not None:
            urls = ElementTree.SubElement(record_element, "urls")
            related = ElementTree.SubElement(urls, "related-urls")
            ElementTree.SubElement(related, "url").text = metadata.url
        notes = _notes(record)
        if notes:
            _xml_styled(record_element, "notes", " | ".join(notes))
    ElementTree.indent(root, space="  ")
    content = ElementTree.tostring(root, encoding="unicode", xml_declaration=True) + "\n"
    return ExportArtifact(
        content=content,
        media_type="application/xml",
        file_extension="xml",
        citation_style=style,
        warnings=_warnings(ordered),
    )
