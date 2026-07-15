from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime

from litehouse.domain import canonical_json
from litehouse.infrastructure.vault.models import AnnotationKind


def _iso8601(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _heading_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("#", "\\#").replace("\n", " ").strip()


@dataclass(frozen=True, slots=True)
class AnnotationExportRecord:
    annotation_id: str
    kind: AnnotationKind
    body: str
    anchor_json: str
    content_sha256: str
    created_at: datetime
    artifact_sha256: str | None
    source_name: str | None
    source_url: str | None
    license_expression: str | None
    license_url: str | None
    quote_text: str | None = None
    page_number: int | None = None

    @property
    def payload(self) -> dict[str, object]:
        return {
            "anchor": json.loads(self.anchor_json),
            "annotation_id": self.annotation_id,
            "annotation_sha256": self.content_sha256,
            "artifact_sha256": self.artifact_sha256,
            "body": self.body,
            "created_at": _iso8601(self.created_at),
            "kind": self.kind.value,
            "license_expression": self.license_expression,
            "license_url": self.license_url,
            "page_number": self.page_number,
            "quote_text": self.quote_text,
            "source_name": self.source_name,
            "source_url": self.source_url,
        }


@dataclass(frozen=True, slots=True)
class AnnotationExportBundle:
    library_item_id: str
    title: str
    item_kind: str
    work_id: str | None
    work_kind: str | None
    work_identifiers: tuple[tuple[str, str], ...]
    annotations: tuple[AnnotationExportRecord, ...]

    @property
    def payload(self) -> dict[str, object]:
        return {
            "annotations": [record.payload for record in self.annotations],
            "export_schema": "litehouse.annotations.v1",
            "library_item": {
                "id": self.library_item_id,
                "item_kind": self.item_kind,
                "title": self.title,
            },
            "work": (
                None
                if self.work_id is None
                else {
                    "id": self.work_id,
                    "identifiers": [
                        {"namespace": namespace, "value": value}
                        for namespace, value in self.work_identifiers
                    ],
                    "kind": self.work_kind,
                }
            ),
        }

    def to_json(self) -> bytes:
        return (canonical_json(self.payload) + "\n").encode("utf-8")

    def to_markdown(self) -> bytes:
        lines = [
            f"# {_heading_text(self.title)} notes and highlights",
            "",
            f"- Litehouse library item: `{self.library_item_id}`",
            f"- Item kind: `{self.item_kind}`",
        ]
        if self.work_id is not None:
            lines.append(f"- Work: `{self.work_id}`")
            lines.append(f"- Work kind: `{self.work_kind}`")
        if self.work_identifiers:
            identifiers = ", ".join(
                f"`{namespace}:{value}`" for namespace, value in self.work_identifiers
            )
            lines.append(f"- Work identifiers: {identifiers}")
        lines.extend(("", "---", ""))
        for record in self.annotations:
            label = "Highlight" if record.kind is AnnotationKind.HIGHLIGHT else "Note"
            page = f" — page {record.page_number}" if record.page_number is not None else ""
            lines.extend((f"## {label}{page}", ""))
            if record.quote_text:
                lines.extend(f"> {line}" for line in record.quote_text.splitlines())
                lines.append("")
            if record.body:
                lines.extend((record.body, ""))
            lines.extend(
                (
                    f"- Annotation SHA-256: `{record.content_sha256}`",
                    f"- Created: `{_iso8601(record.created_at)}`",
                    f"- Anchor: `{record.anchor_json}`",
                )
            )
            if record.artifact_sha256:
                lines.append(f"- Artifact SHA-256: `{record.artifact_sha256}`")
            if record.source_name:
                lines.append(f"- Source: {_heading_text(record.source_name)}")
            if record.source_url:
                lines.append(f"- Source URL: <{record.source_url}>")
            if record.license_expression:
                lines.append(f"- License: `{record.license_expression}`")
            if record.license_url:
                lines.append(f"- License URL: <{record.license_url}>")
            lines.extend(("", "---", ""))
        return ("\n".join(lines).rstrip() + "\n").encode("utf-8")
