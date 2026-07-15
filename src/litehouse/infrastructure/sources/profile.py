from __future__ import annotations

from dataclasses import dataclass

from litehouse.infrastructure.sources.base import MAX_SEARCH_LENGTH, validated_search_term


def _normalized_text(value: str) -> str:
    return " ".join(value.split())


@dataclass(frozen=True, slots=True)
class ResearchSearchProfile:
    topic: str
    expertise_levels: tuple[str, ...]
    prior_knowledge: str = ""

    def __post_init__(self) -> None:
        topic = _normalized_text(self.topic)
        expertise = tuple(_normalized_text(level) for level in self.expertise_levels)
        prior_knowledge = _normalized_text(self.prior_knowledge)
        if not topic:
            raise ValueError("Research topic must not be empty.")
        if not expertise or len(expertise) > 8 or any(not level for level in expertise):
            raise ValueError("One to eight ordered expertise levels are required.")
        if len(set(expertise)) != len(expertise):
            raise ValueError("Ordered expertise levels must not contain duplicates.")
        object.__setattr__(self, "topic", topic)
        object.__setattr__(self, "expertise_levels", expertise)
        object.__setattr__(self, "prior_knowledge", prior_knowledge)

    def build_search_term(self, *, include_background: bool = False) -> str:
        if not include_background:
            return validated_search_term(self.topic)

        parts = [self.topic, f"expertise {' > '.join(self.expertise_levels)}"]
        if self.prior_knowledge:
            parts.append(f"prior knowledge {self.prior_knowledge}")
        search_term = "; ".join(parts)
        if len(search_term) > MAX_SEARCH_LENGTH:
            raise ValueError("Research profile exceeds the source query limit.")
        return validated_search_term(search_term)
