from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import UTC, date, datetime
from enum import StrEnum

from litehouse.infrastructure.literature.models import AccessLevel, CanonicalLiteratureWork

_TOKEN = re.compile(r"[^\W_]+", re.UNICODE)
_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "as",
        "at",
        "by",
        "for",
        "from",
        "in",
        "of",
        "on",
        "or",
        "the",
        "to",
        "with",
    }
)
_METHOD_TERMS = frozenset(
    {
        "algorithm",
        "archive",
        "benchmark",
        "catalogue",
        "corpus",
        "dataset",
        "edition",
        "framework",
        "instrument",
        "method",
        "methodology",
        "protocol",
        "software",
        "standard",
        "survey",
        "tool",
    }
)


class RankingIntent(StrEnum):
    BALANCED = "balanced"
    RELEVANCE = "relevance"
    RECENT_ATTENTION = "recent_attention"
    AGE_NORMALIZED_INFLUENCE = "age_normalized_influence"
    SEMINAL = "seminal"
    METHODOLOGICAL = "methodological"


@dataclass(frozen=True, slots=True)
class RankingSignals:
    query_relevance: float
    recency: float
    cohort_influence_percentile: float
    methodological_signal: float
    metadata_corroboration: float
    access: float


@dataclass(frozen=True, slots=True)
class RankedLiteratureWork:
    work: CanonicalLiteratureWork
    rank: int
    score: float
    intent: RankingIntent
    signals: RankingSignals
    explanation: tuple[str, ...]


def _tokens(value: str) -> frozenset[str]:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return frozenset(
        token for token in _TOKEN.findall(normalized) if len(token) > 1 and token not in _STOPWORDS
    )


def _age(work: CanonicalLiteratureWork, today: date) -> float:
    if work.publication_date is None:
        return 50.0
    return max(0.0, (today - work.publication_date).days / 365.2425)


def _citation_intensity(work: CanonicalLiteratureWork, today: date) -> float:
    citations = work.citation_count or 0
    return math.log1p(citations) / math.sqrt(_age(work, today) + 1.0)


def _percentile(value: float, cohort: list[float]) -> float:
    if not cohort:
        return 0.0
    below = sum(candidate < value for candidate in cohort)
    equal = sum(candidate == value for candidate in cohort)
    return (below + 0.5 * equal) / len(cohort)


def _weights(intent: RankingIntent) -> tuple[float, float, float, float, float, float]:
    return {
        RankingIntent.BALANCED: (0.34, 0.18, 0.20, 0.08, 0.12, 0.08),
        RankingIntent.RELEVANCE: (0.62, 0.10, 0.08, 0.05, 0.10, 0.05),
        RankingIntent.RECENT_ATTENTION: (0.28, 0.34, 0.25, 0.03, 0.06, 0.04),
        RankingIntent.AGE_NORMALIZED_INFLUENCE: (0.20, 0.12, 0.46, 0.04, 0.12, 0.06),
        RankingIntent.SEMINAL: (0.20, 0.02, 0.55, 0.05, 0.14, 0.04),
        RankingIntent.METHODOLOGICAL: (0.22, 0.12, 0.13, 0.35, 0.12, 0.06),
    }[intent]


def rank_literature(
    works: tuple[CanonicalLiteratureWork, ...],
    *,
    query: str,
    intent: RankingIntent = RankingIntent.BALANCED,
    now: datetime | None = None,
) -> tuple[RankedLiteratureWork, ...]:
    today = (now or datetime.now(UTC)).astimezone(UTC).date()
    query_tokens = _tokens(query)
    intensities = {work.identity_key: _citation_intensity(work, today) for work in works}
    scored: list[tuple[CanonicalLiteratureWork, float, RankingSignals, tuple[str, ...]]] = []
    weights = _weights(intent)
    for work in works:
        body_tokens = _tokens(f"{work.work.title} {work.abstract or ''}")
        relevance = len(query_tokens & body_tokens) / len(query_tokens) if query_tokens else 0.0
        age = _age(work, today)
        recency = math.exp(-age / 3.0) if work.publication_date else 0.0
        cohort = [
            intensity
            for candidate in works
            if candidate.work.kind == work.work.kind
            and (
                candidate.publication_date is None
                or work.publication_date is None
                or abs(candidate.publication_date.year - work.publication_date.year) <= 2
            )
            for intensity in [intensities[candidate.identity_key]]
        ]
        influence = _percentile(intensities[work.identity_key], cohort)
        method = min(1.0, len(body_tokens & _METHOD_TERMS) / 2.0)
        corroboration = min(
            1.0,
            0.18 * (len(work.sources) - 1) + 0.16 * len(work.matched_fields),
        )
        access = {
            AccessLevel.OPEN_FULL_TEXT: 1.0,
            AccessLevel.ABSTRACT_ONLY: 0.5,
            AccessLevel.METADATA_ONLY: 0.0,
        }[work.access_level]
        signals = RankingSignals(
            query_relevance=round(relevance, 6),
            recency=round(recency, 6),
            cohort_influence_percentile=round(influence, 6),
            methodological_signal=round(method, 6),
            metadata_corroboration=round(corroboration, 6),
            access=access,
        )
        values = (
            relevance,
            recency,
            influence,
            method,
            corroboration,
            access,
        )
        score = round(sum(weight * value for weight, value in zip(weights, values, strict=True)), 6)
        explanation = (
            f"query relevance {relevance:.0%}",
            f"recency signal {recency:.0%}",
            f"age-and-kind cohort influence percentile {influence:.0%}",
            f"metadata corroboration {corroboration:.0%}",
            f"access {work.access_level.value.replace('_', ' ')}",
            "Ranking signals prioritize discovery; they do not measure scientific truth "
            "or quality.",
        )
        scored.append((work, score, signals, explanation))
    scored.sort(key=lambda item: (-item[1], item[0].identity_key))
    return tuple(
        RankedLiteratureWork(
            work=work,
            rank=index,
            score=score,
            intent=intent,
            signals=signals,
            explanation=explanation,
        )
        for index, (work, score, signals, explanation) in enumerate(scored, start=1)
    )
