from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from litehouse.domain import WorkKind
from litehouse.infrastructure.exports.models import CitationStyle, ReferenceRecord

_ARTICLE_KINDS = frozenset(
    {
        WorkKind.ARTICLE,
        WorkKind.PREPRINT,
        WorkKind.TRIAL,
        WorkKind.PROCEEDINGS_PAPER,
    }
)


@dataclass(frozen=True, slots=True)
class CitationRenderer:
    escape: Callable[[str], str] = str
    italic: Callable[[str], str] = str
    url: Callable[[str], str] = str


def citation_style_label(style: CitationStyle) -> str:
    return {
        CitationStyle.APA: "APA 7",
        CitationStyle.IEEE: "IEEE",
        CitationStyle.CHICAGO_AUTHOR_DATE: "Chicago author-date",
        CitationStyle.MLA: "MLA 9",
        CitationStyle.VANCOUVER: "Vancouver",
        CitationStyle.HARVARD_CITE_THEM_RIGHT: "Harvard Cite Them Right",
    }[style]


def citation_warnings(record: ReferenceRecord) -> tuple[str, ...]:
    warnings: list[str] = []
    metadata = record.metadata
    if not record.work.contributors:
        warnings.append("Contributor metadata is unavailable; a creator placeholder is shown.")
    else:
        warnings.append(
            "Contributor names are preserved as literal source strings; name-part inversion "
            "was not inferred."
        )
    if metadata.issued is None:
        warnings.append("Publication date is unavailable; an explicit date placeholder is shown.")
    if record.work.kind in _ARTICLE_KINDS and metadata.container_title is None:
        warnings.append("Container title is unavailable; a container placeholder is shown.")
    if record.work.kind is WorkKind.CHAPTER and metadata.container_title is None:
        warnings.append("Book title is unavailable; a container placeholder is shown.")
    if record.work.kind not in _ARTICLE_KINDS and metadata.publisher is None:
        warnings.append("Publisher is unavailable; a publisher placeholder is shown.")
    return tuple(warnings)


def format_reference_citation(
    record: ReferenceRecord,
    style: CitationStyle,
    *,
    renderer: CitationRenderer | None = None,
) -> str:
    active = renderer or CitationRenderer()
    if style is CitationStyle.APA:
        return _apa(record, active)
    if style is CitationStyle.IEEE:
        return _ieee(record, active)
    if style is CitationStyle.CHICAGO_AUTHOR_DATE:
        return _chicago(record, active)
    if style is CitationStyle.MLA:
        return _mla(record, active)
    if style is CitationStyle.VANCOUVER:
        return _vancouver(record, active)
    return _harvard(record, active)


def _contributors(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    authors = [
        item for item in record.work.contributors if item.role.casefold() == "author"
    ]
    selected = authors or [
        item for item in record.work.contributors if item.role.casefold() == "editor"
    ]
    if not selected:
        selected = list(record.work.contributors)
    if not selected:
        return renderer.escape("[creator unavailable]")
    names = ", ".join(renderer.escape(item.name) for item in selected)
    return names + (" (ed.)" if not authors and selected else "")


def _role_names(
    record: ReferenceRecord,
    role: str,
    renderer: CitationRenderer,
) -> str | None:
    selected = [
        item
        for item in record.work.contributors
        if item.role.casefold() == role.casefold()
    ]
    if not selected:
        return None
    return ", ".join(renderer.escape(item.name) for item in selected)


def _year(record: ReferenceRecord, renderer: CitationRenderer, *, nd: bool = True) -> str:
    if record.metadata.issued is not None:
        return str(record.metadata.issued.year)
    value = "n.d. [date unavailable]" if nd else "[date unavailable]"
    return renderer.escape(value)


def _link(record: ReferenceRecord, renderer: CitationRenderer) -> str | None:
    doi = next(
        (item.value for item in record.work.identifiers if item.namespace == "doi"),
        None,
    )
    value = f"https://doi.org/{doi}" if doi is not None else record.metadata.url
    return renderer.url(value) if value is not None else None


def _container(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    return renderer.escape(record.metadata.container_title or "[container unavailable]")


def _publisher(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    return renderer.escape(record.metadata.publisher or "[publisher unavailable]")


def _title(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    return renderer.escape(record.work.title)


def _article_details(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    metadata = record.metadata
    details = ""
    if metadata.volume is not None:
        details += renderer.escape(metadata.volume)
    if metadata.issue is not None:
        details += f"({renderer.escape(metadata.issue)})"
    if metadata.pages is not None:
        details += (", " if details else "") + renderer.escape(metadata.pages)
    return details


def _append_link(parts: list[str], link: str | None, *, prefix: str = "") -> None:
    if link is not None:
        parts.append(f"{prefix}{link}")


def _apa(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    metadata = record.metadata
    parts = [f"{_contributors(record, renderer)} ({_year(record, renderer)})."]
    if record.work.kind in _ARTICLE_KINDS:
        parts.append(f"{_title(record, renderer)}.")
        journal = renderer.italic(_container(record, renderer))
        if metadata.volume is not None:
            journal += f", {renderer.italic(renderer.escape(metadata.volume))}"
        if metadata.issue is not None:
            journal += f"({renderer.escape(metadata.issue)})"
        if metadata.pages is not None:
            journal += f", {renderer.escape(metadata.pages)}"
        parts.append(journal + ".")
    elif record.work.kind is WorkKind.CHAPTER:
        container = renderer.italic(_container(record, renderer))
        editors = _role_names(record, "editor", renderer)
        editor_text = f"{editors} (Ed.), " if editors is not None else ""
        pages = (
            f" (pp. {renderer.escape(metadata.pages)})"
            if metadata.pages is not None
            else ""
        )
        parts.append(f"{_title(record, renderer)}. In {editor_text}{container}{pages}.")
        parts.append(f"{_publisher(record, renderer)}.")
    else:
        parts.append(f"{renderer.italic(_title(record, renderer))}.")
        parts.append(f"{_publisher(record, renderer)}.")
    _append_link(parts, _link(record, renderer))
    return " ".join(parts)


def _ieee(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    metadata = record.metadata
    if record.work.kind in _ARTICLE_KINDS:
        parts = [
            f'{_contributors(record, renderer)}, “{_title(record, renderer)},”',
            renderer.italic(_container(record, renderer)),
        ]
        details: list[str] = []
        if metadata.volume is not None:
            details.append(f"vol. {renderer.escape(metadata.volume)}")
        if metadata.issue is not None:
            details.append(f"no. {renderer.escape(metadata.issue)}")
        if metadata.pages is not None:
            details.append(f"pp. {renderer.escape(metadata.pages)}")
        if details:
            parts.append(", ".join(details) + ",")
        parts.append(f"{_year(record, renderer, nd=False)}.")
    elif record.work.kind is WorkKind.CHAPTER:
        parts = [
            f'{_contributors(record, renderer)}, “{_title(record, renderer)},” in',
            f"{renderer.italic(_container(record, renderer))},",
        ]
        editors = _role_names(record, "editor", renderer)
        if editors is not None:
            parts.append(f"{editors}, Ed.,")
        if metadata.publisher_place is not None:
            parts.append(f"{renderer.escape(metadata.publisher_place)}:")
        parts.append(f"{_publisher(record, renderer)}, {_year(record, renderer, nd=False)}")
        if metadata.pages is not None:
            parts.append(f", pp. {renderer.escape(metadata.pages)}.")
        else:
            parts[-1] += "."
    else:
        parts = [
            f"{_contributors(record, renderer)},",
            f"{renderer.italic(_title(record, renderer))}.",
        ]
        if metadata.publisher_place is not None:
            parts.append(f"{renderer.escape(metadata.publisher_place)}:")
        parts.extend((_publisher(record, renderer) + ",", _year(record, renderer, nd=False) + "."))
    _append_link(parts, _link(record, renderer))
    return " ".join(parts)


def _chicago(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    metadata = record.metadata
    parts = [f"{_contributors(record, renderer)}. {_year(record, renderer)}."]
    if record.work.kind in _ARTICLE_KINDS:
        parts.append(f'“{_title(record, renderer)}.”')
        detail = renderer.italic(_container(record, renderer))
        if metadata.volume is not None:
            detail += f" {renderer.escape(metadata.volume)}"
        if metadata.issue is not None:
            detail += f" ({renderer.escape(metadata.issue)})"
        if metadata.pages is not None:
            detail += f": {renderer.escape(metadata.pages)}"
        parts.append(detail + ".")
    elif record.work.kind is WorkKind.CHAPTER:
        parts.append(f'“{_title(record, renderer)}.”')
        container = renderer.italic(_container(record, renderer))
        editors = _role_names(record, "editor", renderer)
        editor_text = f", edited by {editors}" if editors is not None else ""
        pages = (
            f", {renderer.escape(metadata.pages)}" if metadata.pages is not None else ""
        )
        parts.append(f"In {container}{editor_text}{pages}.")
        place = (
            renderer.escape(metadata.publisher_place) + ": "
            if metadata.publisher_place is not None
            else ""
        )
        parts.append(f"{place}{_publisher(record, renderer)}.")
    else:
        parts.append(f"{renderer.italic(_title(record, renderer))}.")
        place = (
            renderer.escape(metadata.publisher_place) + ": "
            if metadata.publisher_place is not None
            else ""
        )
        parts.append(f"{place}{_publisher(record, renderer)}.")
    _append_link(parts, _link(record, renderer))
    return " ".join(parts)


def _mla(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    metadata = record.metadata
    parts = [f"{_contributors(record, renderer)}."]
    if record.work.kind in _ARTICLE_KINDS:
        parts.extend(
            (
                f'“{_title(record, renderer)}.”',
                renderer.italic(_container(record, renderer)) + ",",
            )
        )
        if metadata.volume is not None:
            parts.append(f"vol. {renderer.escape(metadata.volume)},")
        if metadata.issue is not None:
            parts.append(f"no. {renderer.escape(metadata.issue)},")
        parts.append(f"{_year(record, renderer, nd=False)},")
        if metadata.pages is not None:
            parts.append(f"pp. {renderer.escape(metadata.pages)}.")
    elif record.work.kind is WorkKind.CHAPTER:
        parts.extend(
            (
                f'“{_title(record, renderer)}.”',
                renderer.italic(_container(record, renderer)) + ",",
            )
        )
        editors = _role_names(record, "editor", renderer)
        if editors is not None:
            parts.append(f"edited by {editors},")
        parts.extend(
            (
                _publisher(record, renderer) + ",",
                _year(record, renderer, nd=False) + ",",
            )
        )
        if metadata.pages is not None:
            parts.append(f"pp. {renderer.escape(metadata.pages)}.")
    else:
        parts.extend(
            (
                renderer.italic(_title(record, renderer)) + ".",
                _publisher(record, renderer) + ",",
                _year(record, renderer, nd=False) + ".",
            )
        )
    _append_link(parts, _link(record, renderer))
    return " ".join(parts)


def _vancouver(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    metadata = record.metadata
    parts = [f"{_contributors(record, renderer)}. {_title(record, renderer)}."]
    if record.work.kind in _ARTICLE_KINDS:
        details = _article_details(record, renderer)
        journal = renderer.italic(_container(record, renderer))
        journal += f". {_year(record, renderer, nd=False)}"
        if details:
            journal += f";{details.replace(', ', ':', 1)}"
        parts.append(journal + ".")
    elif record.work.kind is WorkKind.CHAPTER:
        editors = _role_names(record, "editor", renderer)
        if editors is not None:
            parts.append(f"In: {editors}, editor.")
        else:
            parts.append("In:")
        parts.append(f"{renderer.italic(_container(record, renderer))}.")
        place = (
            renderer.escape(metadata.publisher_place) + ": "
            if metadata.publisher_place is not None
            else ""
        )
        parts.append(f"{place}{_publisher(record, renderer)}; {_year(record, renderer, nd=False)}.")
        if metadata.pages is not None:
            parts.append(f"p. {renderer.escape(metadata.pages)}.")
    else:
        if metadata.edition is not None:
            parts.append(f"{renderer.escape(metadata.edition)} ed.")
        place = (
            renderer.escape(metadata.publisher_place) + ": "
            if metadata.publisher_place is not None
            else ""
        )
        parts.append(f"{place}{_publisher(record, renderer)}; {_year(record, renderer, nd=False)}.")
    _append_link(parts, _link(record, renderer))
    return " ".join(parts)


def _harvard(record: ReferenceRecord, renderer: CitationRenderer) -> str:
    metadata = record.metadata
    parts = [f"{_contributors(record, renderer)} ({_year(record, renderer)})"]
    if record.work.kind in _ARTICLE_KINDS:
        parts.append(f"‘{_title(record, renderer)}’,")
        detail = renderer.italic(_container(record, renderer))
        if metadata.volume is not None:
            detail += f", {renderer.escape(metadata.volume)}"
        if metadata.issue is not None:
            detail += f"({renderer.escape(metadata.issue)})"
        if metadata.pages is not None:
            detail += f", pp. {renderer.escape(metadata.pages)}"
        parts.append(detail + ".")
    elif record.work.kind is WorkKind.CHAPTER:
        parts.append(f"‘{_title(record, renderer)}’,")
        editors = _role_names(record, "editor", renderer)
        if editors is not None:
            parts.append(f"in {editors} (ed.),")
        else:
            parts.append("in")
        parts.append(f"{renderer.italic(_container(record, renderer))}.")
        if metadata.pages is not None:
            parts.append(f"pp. {renderer.escape(metadata.pages)}.")
        if metadata.publisher_place is not None:
            parts.append(f"{renderer.escape(metadata.publisher_place)}:")
        parts.append(f"{_publisher(record, renderer)}.")
    else:
        parts.append(f"{renderer.italic(_title(record, renderer))}.")
        if metadata.edition is not None:
            parts.append(f"{renderer.escape(metadata.edition)} edn.")
        if metadata.publisher_place is not None:
            parts.append(f"{renderer.escape(metadata.publisher_place)}:")
        parts.append(f"{_publisher(record, renderer)}.")
    _append_link(parts, _link(record, renderer), prefix="Available at: ")
    return " ".join(parts)
