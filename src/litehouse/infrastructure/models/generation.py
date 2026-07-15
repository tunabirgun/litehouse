from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import cast

from litehouse.domain.entities import EvidenceSegment


class GenerationContractError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class CandidateClaim:
    claim_id: str
    text: str
    evidence_ids: tuple[str, ...]


def _string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GenerationContractError(f"{field} must be a non-empty string")
    return value.strip()


def _parse_payload(payload: str | Mapping[str, object]) -> Mapping[str, object]:
    if isinstance(payload, str):
        try:
            parsed: object = json.loads(payload)
        except json.JSONDecodeError as error:
            raise GenerationContractError("model output is not valid JSON") from error
        if not isinstance(parsed, dict):
            raise GenerationContractError("model output must be a JSON object")
        return cast(dict[str, object], parsed)
    return payload


def validate_evidence_only_generation(
    payload: str | Mapping[str, object], *, known_evidence_ids: set[str] | frozenset[str]
) -> tuple[CandidateClaim, ...]:
    document = _parse_payload(payload)
    if set(document) != {"claims"}:
        raise GenerationContractError("model output must contain only the claims field")
    claims_value = document["claims"]
    if not isinstance(claims_value, list):
        raise GenerationContractError("claims must be a JSON array")

    claims: list[CandidateClaim] = []
    seen_claims: set[str] = set()
    for index, raw_claim in enumerate(claims_value):
        if not isinstance(raw_claim, dict):
            raise GenerationContractError(f"claims[{index}] must be an object")
        claim = cast(dict[str, object], raw_claim)
        if set(claim) != {"claim_id", "text", "evidence_ids"}:
            raise GenerationContractError(f"claims[{index}] has missing or unsupported fields")
        claim_id = _string(claim["claim_id"], f"claims[{index}].claim_id")
        if claim_id in seen_claims:
            raise GenerationContractError(f"duplicate claim_id: {claim_id}")
        seen_claims.add(claim_id)
        text = _string(claim["text"], f"claims[{index}].text")
        raw_evidence = claim["evidence_ids"]
        if not isinstance(raw_evidence, list) or not raw_evidence:
            raise GenerationContractError(f"claims[{index}].evidence_ids must be a non-empty array")
        evidence_ids = tuple(
            _string(value, f"claims[{index}].evidence_ids") for value in raw_evidence
        )
        if len(set(evidence_ids)) != len(evidence_ids):
            raise GenerationContractError(f"claims[{index}] repeats an evidence ID")
        unknown = sorted(set(evidence_ids) - known_evidence_ids)
        if unknown:
            raise GenerationContractError(
                f"claims[{index}] references unknown evidence IDs: {', '.join(unknown)}"
            )
        claims.append(CandidateClaim(claim_id, text, evidence_ids))
    return tuple(claims)


def validate_grounded_generation(
    payload: str | Mapping[str, object],
    *,
    evidence_segments: tuple[EvidenceSegment, ...],
) -> tuple[CandidateClaim, ...]:
    if not evidence_segments:
        raise GenerationContractError("at least one evidence segment is required")
    evidence_ids = [segment.id for segment in evidence_segments]
    if any(not evidence_id.strip() for evidence_id in evidence_ids):
        raise GenerationContractError("evidence segment IDs must be non-empty")
    if len(set(evidence_ids)) != len(evidence_ids):
        raise GenerationContractError("evidence segment IDs must be unique")
    if any(not segment.verifies(segment.text) for segment in evidence_segments):
        raise GenerationContractError("an evidence segment failed SHA-256 verification")
    return validate_evidence_only_generation(payload, known_evidence_ids=set(evidence_ids))
